import { ObjectId, type Collection, type Filter, type Sort } from 'mongodb';
import type {
  DemandCancelInput,
  DemandCreateInput,
  DemandDetail,
  DemandLineInput,
  DemandListQuery,
  DemandListResponse,
  DemandSummary,
  DemandUpdateInput,
  MasterEntityKey,
  MasterRef,
} from '../contracts/api.js';
import type { Database } from '../db/mongo.js';
import type { MutationContext } from '../domain/context.js';
import { ConflictError, NotFoundError, ValidationError, type ErrorDetail } from '../errors.js';
import type { MasterRecordDoc } from '../masterData/definitions.js';
import type { RecordStore } from '../records/recordStore.js';
import {
  DEMANDS_COLLECTION,
  demandDefinition,
  type DemandDoc,
  type DemandFields,
  type StoredDemandLine,
} from './definitions.js';

const EARLIEST_DATE = '2000-01-01';

/** Today's date in the organisation's time zone (Asia/Karachi), as YYYY-MM-DD. */
export function todayInKarachi(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type RefDocs = Map<string, MasterRecordDoc>;

interface ViewOptions {
  /** Receiver names/phones are personal data (Q-30): shown to the Production Operator only. */
  includePersonalData: boolean;
}

/**
 * Demand management (M5). All writes go through the M2 RecordStore (validation, Demand Number,
 * revision checks, audit, queued sync jobs). Cancellation archives the demand with a reason (D9);
 * nothing is deleted. Fulfilment is derived from dispatch lines, which arrive in M8 — until then
 * every line has quantityDelivered = 0 and is PENDING.
 */
export class DemandService {
  constructor(
    private readonly database: Database,
    private readonly store: RecordStore,
  ) {}

  private get demands(): Collection<DemandDoc> {
    return this.database.db.collection<DemandDoc>(DEMANDS_COLLECTION);
  }

  private master(entity: MasterEntityKey): Collection<MasterRecordDoc> {
    return this.database.db.collection<MasterRecordDoc>(entity);
  }

  async list(query: DemandListQuery): Promise<DemandListResponse> {
    const filter: Filter<DemandDoc> = {};
    if (query.status === 'open') filter['lifecycle.state'] = 'ACTIVE';
    if (query.status === 'cancelled') filter['lifecycle.state'] = 'ARCHIVED';
    if (query.departmentId) filter.departmentId = new ObjectId(query.departmentId);
    if (query.provinceId) filter.provinceId = new ObjectId(query.provinceId);
    if (query.from || query.to) {
      filter.demandDate = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }
    if (query.search) {
      // Matches the Demand Number (code) or the source reference, literally and case-insensitively.
      const pattern = escapeRegex(query.search.toLowerCase().replace(/\s+/g, ' '));
      filter.$or = [
        { code: { $regex: pattern, $options: 'i' } },
        { searchText: { $regex: pattern } },
      ];
    }
    const sorts: Record<DemandListQuery['sort'], Sort> = {
      demandDate_desc: { demandDate: -1, code: -1 },
      demandDate_asc: { demandDate: 1, code: 1 },
      code_desc: { code: -1 },
      code_asc: { code: 1 },
    };
    const [docs, total] = await Promise.all([
      this.demands
        .find(filter)
        .sort(sorts[query.sort])
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .toArray(),
      this.demands.countDocuments(filter),
    ]);
    const refs = await this.loadRefs(docs);
    return {
      items: docs.map((doc) => this.toSummary(doc, refs)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async get(id: string, view: ViewOptions): Promise<DemandDetail> {
    const doc = await this.findOrThrow(id);
    return this.toDetail(doc, await this.loadRefs([doc]), view);
  }

  async create(input: DemandCreateInput, ctx: MutationContext): Promise<DemandDetail> {
    const errors: ErrorDetail[] = [];
    this.checkDate(input.demandDate, errors);
    const header = await this.resolveHeader(
      {
        departmentId: input.departmentId,
        provinceId: input.provinceId,
        divisionId: input.divisionId ?? null,
      },
      null,
      errors,
    );
    const lines = await this.buildLines(input.lines, null, errors);
    if (errors.length > 0) throw new ValidationError(errors);

    const fields: DemandFields = {
      demandDate: input.demandDate,
      ...header,
      sourceReference: input.sourceReference ?? null,
      searchText: searchTextOf(input.sourceReference ?? null),
      nextLineNo: lines.nextLineNo,
      lines: lines.lines,
    };
    const created = (await this.store.create(demandDefinition, fields, ctx)) as DemandDoc;
    return this.toDetail(created, await this.loadRefs([created]), { includePersonalData: true });
  }

  async update(id: string, input: DemandUpdateInput, ctx: MutationContext): Promise<DemandDetail> {
    const current = await this.findOrThrow(id);
    if (current.lifecycle.state !== 'ACTIVE') {
      throw new ConflictError('This demand is cancelled and cannot be changed');
    }
    const errors: ErrorDetail[] = [];
    const changes: Partial<DemandFields> = {};

    if (input.demandDate !== undefined) {
      this.checkDate(input.demandDate, errors);
      changes.demandDate = input.demandDate;
    }
    if (
      input.departmentId !== undefined ||
      input.provinceId !== undefined ||
      input.divisionId !== undefined
    ) {
      const header = await this.resolveHeader(
        {
          departmentId: input.departmentId ?? current.departmentId.toHexString(),
          provinceId: input.provinceId ?? current.provinceId.toHexString(),
          divisionId:
            input.divisionId === undefined
              ? (current.divisionId?.toHexString() ?? null)
              : input.divisionId,
        },
        current,
        errors,
      );
      Object.assign(changes, header);
    }
    if (input.sourceReference !== undefined) {
      changes.sourceReference = input.sourceReference;
      changes.searchText = searchTextOf(input.sourceReference);
    }
    if (input.lines !== undefined) {
      const built = await this.buildLines(input.lines, current, errors);
      changes.lines = built.lines;
      changes.nextLineNo = built.nextLineNo;
    }
    if (errors.length > 0) throw new ValidationError(errors);

    const updated = (await this.store.update(
      demandDefinition,
      current._id,
      input.rev,
      changes,
      ctx,
    )) as DemandDoc;
    return this.toDetail(updated, await this.loadRefs([updated]), { includePersonalData: true });
  }

  /** Cancels a demand with a reason (D9). The record is kept and stays readable. */
  async cancel(id: string, input: DemandCancelInput, ctx: MutationContext): Promise<DemandDetail> {
    const current = await this.findOrThrow(id);
    if (current.lifecycle.state !== 'ACTIVE') {
      throw new ConflictError('This demand is already cancelled');
    }
    const cancelled = (await this.store.archive(
      demandDefinition,
      current._id,
      input.rev,
      input.reason,
      ctx,
    )) as DemandDoc;
    return this.toDetail(cancelled, await this.loadRefs([cancelled]), {
      includePersonalData: true,
    });
  }

  /** Lines of open demands that still have a remaining quantity (dashboard indicator). */
  async countOpenLines(): Promise<number> {
    const [result] = await this.demands
      .aggregate<{ total: number }>([
        { $match: { 'lifecycle.state': 'ACTIVE' } },
        { $group: { _id: null, total: { $sum: { $size: '$lines' } } } },
      ])
      .toArray();
    // No dispatches exist before M8, so every line of an open demand is still open.
    return result?.total ?? 0;
  }

  // ---- validation helpers ----

  private checkDate(date: string, errors: ErrorDetail[]): void {
    if (date < EARLIEST_DATE) {
      errors.push({ path: 'demandDate', message: `Date must be on or after ${EARLIEST_DATE}` });
    } else if (date > todayInKarachi()) {
      // M1 R-16: future-dated entries were found in the workbooks.
      errors.push({ path: 'demandDate', message: 'Date cannot be in the future' });
    }
  }

  /**
   * Checks a reference. A new or changed reference must exist and be active; an unchanged
   * reference only has to exist, so deactivating a master record never breaks existing demands.
   */
  private async checkRef(
    entity: MasterEntityKey,
    id: string,
    previous: ObjectId | null | undefined,
    path: string,
    label: string,
    errors: ErrorDetail[],
  ): Promise<MasterRecordDoc | null> {
    const doc = await this.master(entity).findOne({ _id: new ObjectId(id) });
    if (!doc) {
      errors.push({ path, message: `${label} not found` });
      return null;
    }
    const unchanged = previous !== undefined && previous !== null && previous.equals(doc._id);
    if (!doc.active && !unchanged) {
      errors.push({ path, message: `${label} "${doc.name}" is inactive` });
    }
    return doc;
  }

  private async resolveHeader(
    input: { departmentId: string; provinceId: string; divisionId: string | null },
    current: DemandDoc | null,
    errors: ErrorDetail[],
  ): Promise<Pick<DemandFields, 'departmentId' | 'provinceId' | 'divisionId'>> {
    const department = await this.checkRef(
      'departments',
      input.departmentId,
      current?.departmentId,
      'departmentId',
      'Department',
      errors,
    );
    const province = await this.checkRef(
      'provinces',
      input.provinceId,
      current?.provinceId,
      'provinceId',
      'Province',
      errors,
    );
    let divisionId: ObjectId | null = null;
    if (input.divisionId) {
      const division = await this.checkRef(
        'divisions',
        input.divisionId,
        current?.divisionId,
        'divisionId',
        'Division',
        errors,
      );
      // A division belongs to exactly one province (M4), so the pair must be consistent.
      if (division && province && !division.provinceId?.equals(province._id)) {
        errors.push({
          path: 'divisionId',
          message: `Division "${division.name}" does not belong to province "${province.name}"`,
        });
      }
      divisionId = division?._id ?? null;
    }
    return {
      departmentId: department?._id ?? new ObjectId(input.departmentId),
      provinceId: province?._id ?? new ObjectId(input.provinceId),
      divisionId,
    };
  }

  private async buildLines(
    inputs: DemandLineInput[],
    current: DemandDoc | null,
    errors: ErrorDetail[],
  ): Promise<{ lines: StoredDemandLine[]; nextLineNo: number }> {
    const existing = new Map((current?.lines ?? []).map((l) => [l._id.toHexString(), l]));
    let nextLineNo = current?.nextLineNo ?? 1;
    const seenIds = new Set<string>();
    const seenPairs = new Map<string, number>();
    const lines: StoredDemandLine[] = [];

    for (const [index, input] of inputs.entries()) {
      const path = `lines.${index}`;
      const previous = input.id ? existing.get(input.id) : undefined;
      if (input.id && !previous) {
        errors.push({ path: `${path}.id`, message: 'Line does not belong to this demand' });
        continue;
      }
      if (input.id) {
        if (seenIds.has(input.id)) {
          errors.push({ path: `${path}.id`, message: 'Line listed twice' });
          continue;
        }
        seenIds.add(input.id);
      }
      const item = await this.checkRef(
        'items',
        input.itemId,
        previous?.itemId,
        `${path}.itemId`,
        'Item',
        errors,
      );
      const destination = await this.checkRef(
        'divisions',
        input.destinationDivisionId,
        previous?.destinationDivisionId,
        `${path}.destinationDivisionId`,
        'Destination division',
        errors,
      );
      // A demand line is identified by item + destination (M1 A-04): no duplicates in one demand.
      const pairKey = `${input.itemId}:${input.destinationDivisionId}`;
      const firstIndex = seenPairs.get(pairKey);
      if (firstIndex !== undefined) {
        errors.push({
          path,
          message: `Duplicate line: same item and destination as line ${firstIndex + 1}. Combine the quantities instead.`,
        });
      } else {
        seenPairs.set(pairKey, index);
      }
      if (!item || !destination) continue;

      lines.push({
        _id: previous?._id ?? new ObjectId(),
        lineNo: previous?.lineNo ?? nextLineNo++,
        itemId: item._id,
        destinationDivisionId: destination._id,
        quantity: input.quantity,
        receiverName: input.receiverName ?? null,
        receiverPhone: input.receiverPhone ?? null,
      });
    }
    // Removing a line is allowed while no dispatch references it; dispatches arrive in M8, which
    // must then block removal of lines that have dispatches.
    return { lines, nextLineNo };
  }

  // ---- read helpers ----

  private async findOrThrow(id: string): Promise<DemandDoc> {
    const doc = /^[a-f0-9]{24}$/.test(id)
      ? await this.demands.findOne({ _id: new ObjectId(id) })
      : null;
    if (!doc) throw new NotFoundError('Demand not found');
    return doc;
  }

  private async loadRefs(docs: DemandDoc[]): Promise<Record<string, RefDocs>> {
    const ids = {
      departments: new Set<string>(),
      provinces: new Set<string>(),
      divisions: new Set<string>(),
      items: new Set<string>(),
    };
    for (const doc of docs) {
      ids.departments.add(doc.departmentId.toHexString());
      ids.provinces.add(doc.provinceId.toHexString());
      if (doc.divisionId) ids.divisions.add(doc.divisionId.toHexString());
      for (const line of doc.lines) {
        ids.items.add(line.itemId.toHexString());
        ids.divisions.add(line.destinationDivisionId.toHexString());
      }
    }
    const result: Record<string, RefDocs> = {};
    for (const [entity, set] of Object.entries(ids)) {
      const found = await this.master(entity as MasterEntityKey)
        .find({ _id: { $in: [...set].map((s) => new ObjectId(s)) } })
        .toArray();
      result[entity] = new Map(found.map((d) => [d._id.toHexString(), d]));
    }
    // Province names of destination divisions.
    const destinationProvinceIds = [...(result.divisions?.values() ?? [])]
      .map((d) => d.provinceId?.toHexString())
      .filter((id): id is string => Boolean(id) && !result.provinces?.has(id as string));
    if (destinationProvinceIds.length > 0) {
      const more = await this.master('provinces')
        .find({ _id: { $in: destinationProvinceIds.map((s) => new ObjectId(s)) } })
        .toArray();
      for (const doc of more) result.provinces?.set(doc._id.toHexString(), doc);
    }
    return result;
  }

  private toSummary(doc: DemandDoc, refs: Record<string, RefDocs>): DemandSummary {
    return {
      id: doc._id.toHexString(),
      code: doc.code,
      demandDate: doc.demandDate,
      status: doc.lifecycle.state === 'ACTIVE' ? 'OPEN' : 'CANCELLED',
      fulfilment: 'PENDING',
      department: refOf(refs.departments, doc.departmentId),
      province: refOf(refs.provinces, doc.provinceId),
      division: doc.divisionId ? refOf(refs.divisions, doc.divisionId) : null,
      sourceReference: doc.sourceReference,
      lineCount: doc.lines.length,
      totalQuantity: doc.lines.reduce((sum, line) => sum + line.quantity, 0),
      rev: doc.rev,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };
  }

  private toDetail(doc: DemandDoc, refs: Record<string, RefDocs>, view: ViewOptions): DemandDetail {
    const lifecycle = doc.lifecycle;
    return {
      ...this.toSummary(doc, refs),
      lines: [...doc.lines]
        .sort((a, b) => a.lineNo - b.lineNo)
        .map((line) => {
          const destination = refs.divisions?.get(line.destinationDivisionId.toHexString());
          const provinceName = destination?.provinceId
            ? (refs.provinces?.get(destination.provinceId.toHexString())?.name ?? null)
            : null;
          const quantityDelivered = 0; // From dispatch lines in M8.
          return {
            id: line._id.toHexString(),
            lineNo: line.lineNo,
            item: refOf(refs.items, line.itemId),
            destinationDivision: {
              ...refOf(refs.divisions, line.destinationDivisionId),
              provinceName,
            },
            quantity: line.quantity,
            quantityDelivered,
            quantityRemaining: line.quantity - quantityDelivered,
            fulfilment: 'PENDING' as const,
            ...(view.includePersonalData
              ? { receiverName: line.receiverName, receiverPhone: line.receiverPhone }
              : {}),
          };
        }),
      cancellation:
        lifecycle.state === 'ARCHIVED' && lifecycle.archivedAt
          ? {
              at: lifecycle.archivedAt.toISOString(),
              reason: lifecycle.archiveReason ?? '',
              by: lifecycle.archivedBy?.label ?? null,
            }
          : null,
      personalDataVisible: view.includePersonalData,
    };
  }
}

function searchTextOf(reference: string | null): string {
  return (reference ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function refOf(map: RefDocs | undefined, id: ObjectId): MasterRef {
  const doc = map?.get(id.toHexString());
  if (!doc) return { id: id.toHexString(), code: '', name: '(missing record)', active: false };
  return { id: doc._id.toHexString(), code: doc.code, name: doc.name, active: doc.active };
}
