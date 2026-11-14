import { ObjectId, type Collection, type Filter } from 'mongodb';
import type {
  CancelWithReasonInput,
  DispatchCreateInput,
  DispatchDetail,
  DispatchListQuery,
  DispatchListResponse,
  DispatchSummary,
  DispatchUpdateInput,
} from '../contracts/operations.js';
import type { Database } from '../db/mongo.js';
import { DEMANDS_COLLECTION, type DemandDoc } from '../demands/definitions.js';
import { todayInKarachi } from '../demands/demandService.js';
import type { MutationContext } from '../domain/context.js';
import { ConflictError, NotFoundError, ValidationError, type ErrorDetail } from '../errors.js';
import {
  actorLabel,
  addToTally,
  changeStock,
  escapeRegex,
  fetchMasterMap,
  getStockBalance,
  insertMovements,
  loadLocationMaps,
  locationOf,
  readTallies,
  refOf,
  tallyKey,
  type RefDocs,
  type StockMovementDoc,
} from '../inventory/ledger.js';
import type { MasterRecordDoc } from '../masterData/definitions.js';
import {
  PURCHASE_ORDERS_COLLECTION,
  type PurchaseOrderDoc,
} from '../purchaseOrders/definitions.js';
import type { RecordStore } from '../records/recordStore.js';
import {
  DISPATCHES_COLLECTION,
  dispatchDefinition,
  type DispatchDoc,
  type DispatchFields,
  type StoredDispatchLine,
} from './dispatchDefinitions.js';

const EARLIEST_DATE = '2000-01-01';

/**
 * Dispatch, Bilty and documents (M8).
 * A dispatch moves stock out of a location (a warehouse, or a division holding direct-route goods)
 * to a destination division. It is never a vendor receipt. Optional demand-line links drive demand
 * fulfilment (delivered/remaining). Stock and demand tallies are guarded in the same transaction,
 * so stock cannot go negative and a demand line cannot be over-delivered (M1 Q-11 is open; the
 * most restrictive rule is applied). Bilty/transport details and document links may be completed
 * later; lines are corrected by cancelling the dispatch (with reason), which returns the stock.
 */
export class DispatchService {
  constructor(
    private readonly database: Database,
    private readonly store: RecordStore,
  ) {}

  private get dispatches(): Collection<DispatchDoc> {
    return this.database.db.collection<DispatchDoc>(DISPATCHES_COLLECTION);
  }

  async list(query: DispatchListQuery): Promise<DispatchListResponse> {
    const filter: Filter<DispatchDoc> = {};
    if (query.status === 'open') filter['lifecycle.state'] = 'ACTIVE';
    if (query.status === 'cancelled') filter['lifecycle.state'] = 'ARCHIVED';
    if (query.destinationDivisionId) {
      filter.destinationDivisionId = new ObjectId(query.destinationDivisionId);
    }
    if (query.sourceKind) filter.sourceKind = query.sourceKind;
    if (query.sourceId) filter.sourceId = new ObjectId(query.sourceId);
    if (query.demandId) filter.demandId = new ObjectId(query.demandId);
    if (query.purchaseOrderId) {
      filter['lines.purchaseOrderId'] = new ObjectId(query.purchaseOrderId);
    }
    if (query.from || query.to) {
      filter.dispatchDate = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }
    if (query.search) {
      const pattern = escapeRegex(query.search.toLowerCase().replace(/\s+/g, ' '));
      filter.$or = [
        { code: { $regex: pattern, $options: 'i' } },
        { searchText: { $regex: pattern } },
      ];
    }
    const [docs, total] = await Promise.all([
      this.dispatches
        .find(filter)
        .sort({ dispatchDate: -1, code: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .toArray(),
      this.dispatches.countDocuments(filter),
    ]);
    const refs = await this.loadRefs(docs);
    return {
      items: docs.map((doc) => this.toSummary(doc, refs)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async get(id: string): Promise<DispatchDetail> {
    const doc = await this.findOrThrow(id);
    return this.toDetail(doc, await this.loadRefs([doc]));
  }

  async create(input: DispatchCreateInput, ctx: MutationContext): Promise<DispatchDetail> {
    const db = this.database.db;
    const errors: ErrorDetail[] = [];
    if (input.dispatchDate < EARLIEST_DATE) {
      errors.push({ path: 'dispatchDate', message: `Date must be on or after ${EARLIEST_DATE}` });
    } else if (input.dispatchDate > todayInKarachi()) {
      errors.push({ path: 'dispatchDate', message: 'Date cannot be in the future' });
    }

    const sourceId = new ObjectId(input.sourceId);
    const source = await db
      .collection<MasterRecordDoc>(input.sourceKind === 'WAREHOUSE' ? 'warehouses' : 'divisions')
      .findOne({ _id: sourceId });
    if (!source) {
      errors.push({
        path: 'sourceId',
        message: input.sourceKind === 'WAREHOUSE' ? 'Warehouse not found' : 'Division not found',
      });
    }
    const destinationId = new ObjectId(input.destinationDivisionId);
    const destination = await db
      .collection<MasterRecordDoc>('divisions')
      .findOne({ _id: destinationId });
    if (!destination) {
      errors.push({ path: 'destinationDivisionId', message: 'Division not found' });
    } else if (!destination.active) {
      errors.push({
        path: 'destinationDivisionId',
        message: `Division "${destination.name}" is inactive`,
      });
    }
    if (input.sourceKind === 'DIVISION' && !sourceId.equals(destinationId)) {
      errors.push({
        path: 'destinationDivisionId',
        message:
          'Direct-route goods held at a division can only be handed over within that division',
      });
    }

    let demand: DemandDoc | null = null;
    if (input.demandId) {
      demand = await db
        .collection<DemandDoc>(DEMANDS_COLLECTION)
        .findOne({ _id: new ObjectId(input.demandId) });
      if (!demand) {
        errors.push({ path: 'demandId', message: 'Demand not found' });
      } else if (demand.lifecycle.state !== 'ACTIVE') {
        errors.push({ path: 'demandId', message: 'This demand is cancelled' });
      }
    }

    // Resolve lots (PO lines) in one query.
    const lineIds = [...new Set(input.lines.map((l) => l.poLineId))].map((id) => new ObjectId(id));
    const pos = await db
      .collection<PurchaseOrderDoc>(PURCHASE_ORDERS_COLLECTION)
      .find({ 'lines._id': { $in: lineIds } })
      .toArray();
    const lotIndex = new Map<
      string,
      { po: PurchaseOrderDoc; line: PurchaseOrderDoc['lines'][number] }
    >();
    for (const po of pos) {
      for (const line of po.lines) lotIndex.set(line._id.toHexString(), { po, line });
    }
    const demandLines = new Map((demand?.lines ?? []).map((l) => [l._id.toHexString(), l]));
    const delivered = await readTallies(
      db,
      [...demandLines.values()].map((l) => tallyKey.dispatched(l._id)),
    );
    const location = { kind: input.sourceKind, id: sourceId };

    const seen = new Set<string>();
    const stockNeeded = new Map<string, number>();
    const demandNeeded = new Map<string, number>();
    const lines: StoredDispatchLine[] = [];
    for (const [index, line] of input.lines.entries()) {
      const path = `lines.${index}`;
      const lot = lotIndex.get(line.poLineId);
      if (!lot) {
        errors.push({ path: `${path}.poLineId`, message: 'Stock lot (PO line) not found' });
        continue;
      }
      const pairKey = `${line.poLineId}:${line.demandLineId ?? '-'}`;
      if (seen.has(pairKey)) {
        errors.push({
          path: `${path}.poLineId`,
          message: 'This lot is listed twice; combine the quantities',
        });
        continue;
      }
      seen.add(pairKey);
      stockNeeded.set(line.poLineId, (stockNeeded.get(line.poLineId) ?? 0) + line.quantity);

      let demandLineNo: number | null = null;
      let demandLineId: ObjectId | null = null;
      if (line.demandLineId) {
        if (!demand) {
          errors.push({ path: `${path}.demandLineId`, message: 'Choose the demand first' });
        } else {
          const dLine = demandLines.get(line.demandLineId);
          if (!dLine) {
            errors.push({
              path: `${path}.demandLineId`,
              message: 'Line does not belong to this demand',
            });
          } else {
            demandLineId = dLine._id;
            demandLineNo = dLine.lineNo;
            if (!dLine.itemId.equals(lot.line.itemId)) {
              errors.push({
                path: `${path}.demandLineId`,
                message: 'The demand line is for a different item than this stock lot',
              });
            }
            if (!dLine.destinationDivisionId.equals(destinationId)) {
              errors.push({
                path: `${path}.demandLineId`,
                message: 'The demand line is for a different destination division',
              });
            }
            const key = dLine._id.toHexString();
            demandNeeded.set(key, (demandNeeded.get(key) ?? 0) + line.quantity);
            const remaining = dLine.quantity - (delivered.get(tallyKey.dispatched(dLine._id)) ?? 0);
            if ((demandNeeded.get(key) ?? 0) > remaining) {
              errors.push({
                path: `${path}.quantity`,
                message: `Only ${remaining} unit(s) remain to be delivered on demand line ${dLine.lineNo}`,
              });
            }
          }
        }
      }
      lines.push({
        _id: new ObjectId(),
        lineNo: index + 1,
        itemId: lot.line.itemId,
        purchaseOrderId: lot.po._id,
        purchaseOrderCode: lot.po.code,
        poNumber: lot.po.poNumber,
        poLineId: lot.line._id,
        poLineNo: lot.line.lineNo,
        quantity: line.quantity,
        demandLineId,
        demandLineNo,
      });
    }
    for (const [poLineId, needed] of stockNeeded) {
      const available = await getStockBalance(db, location, new ObjectId(poLineId));
      if (needed > available) {
        const index = input.lines.findIndex((l) => l.poLineId === poLineId);
        errors.push({
          path: `lines.${index}.quantity`,
          message: `Only ${available} unit(s) of this lot are in stock at the source`,
        });
      }
    }
    if (errors.length > 0) throw new ValidationError(errors);

    const fields: DispatchFields = {
      dispatchDate: input.dispatchDate,
      sourceKind: input.sourceKind,
      sourceId,
      destinationDivisionId: destinationId,
      demandId: demand?._id ?? null,
      demandCode: demand?.code ?? null,
      biltyNo: input.biltyNo ?? null,
      transporterName: input.transporterName ?? null,
      vehicleNo: input.vehicleNo ?? null,
      freightAmount: input.freightAmount ?? null,
      notes: input.notes ?? null,
      documents: input.documents.map((d) => ({ label: d.label, url: d.url })),
      lines,
      totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0),
      searchText: '',
    };
    fields.searchText = searchTextOf(fields);

    const created = (await this.store.create(
      dispatchDefinition,
      fields,
      ctx,
      async (session, record) => {
        const now = new Date();
        const movements: StockMovementDoc[] = [];
        for (const line of lines) {
          const lot = {
            location,
            itemId: line.itemId,
            purchaseOrderId: line.purchaseOrderId,
            poLineId: line.poLineId,
          };
          if (!(await changeStock(db, session, lot, -line.quantity))) {
            throw new ConflictError(
              `Not enough stock of ${line.poNumber} line ${line.poLineNo} at the source (it may have just been dispatched); reload and try again`,
            );
          }
          if (line.demandLineId) {
            const dLine = demandLines.get(line.demandLineId.toHexString())!;
            const ok = await addToTally(
              db,
              session,
              tallyKey.dispatched(line.demandLineId),
              line.quantity,
              dLine.quantity,
            );
            if (!ok) {
              throw new ConflictError(
                `Demand line ${dLine.lineNo} would be over-delivered (someone else may have just dispatched it); reload and try again`,
              );
            }
          }
          movements.push({
            _id: new ObjectId(),
            movementDate: input.dispatchDate,
            recordedAt: now,
            type: 'DISPATCH',
            locationKind: location.kind,
            locationId: location.id,
            itemId: line.itemId,
            purchaseOrderId: line.purchaseOrderId,
            poLineId: line.poLineId,
            quantity: -line.quantity,
            source: { kind: 'DISPATCH', id: record._id, code: record.code },
            actor: ctx.actor,
          });
        }
        await insertMovements(db, session, movements);
      },
    )) as DispatchDoc;
    return this.toDetail(created, await this.loadRefs([created]));
  }

  async update(
    id: string,
    input: DispatchUpdateInput,
    ctx: MutationContext,
  ): Promise<DispatchDetail> {
    const current = await this.findOrThrow(id);
    if (current.lifecycle.state !== 'ACTIVE') {
      throw new ConflictError('This dispatch is cancelled and cannot be changed');
    }
    const changes: Partial<DispatchFields> = {};
    if (input.biltyNo !== undefined) changes.biltyNo = input.biltyNo;
    if (input.transporterName !== undefined) changes.transporterName = input.transporterName;
    if (input.vehicleNo !== undefined) changes.vehicleNo = input.vehicleNo;
    if (input.freightAmount !== undefined) changes.freightAmount = input.freightAmount;
    if (input.notes !== undefined) changes.notes = input.notes;
    if (input.documents !== undefined) {
      changes.documents = input.documents.map((d) => ({ label: d.label, url: d.url }));
    }
    changes.searchText = searchTextOf({ ...current, ...changes } as DispatchFields);
    const updated = (await this.store.update(
      dispatchDefinition,
      current._id,
      input.rev,
      changes,
      ctx,
    )) as DispatchDoc;
    return this.toDetail(updated, await this.loadRefs([updated]));
  }

  async cancel(
    id: string,
    input: CancelWithReasonInput,
    ctx: MutationContext,
  ): Promise<DispatchDetail> {
    const current = await this.findOrThrow(id);
    if (current.lifecycle.state !== 'ACTIVE') {
      throw new ConflictError('This dispatch is already cancelled');
    }
    const db = this.database.db;
    const location = { kind: current.sourceKind, id: current.sourceId };
    const today = todayInKarachi();
    const cancelled = (await this.store.archive(
      dispatchDefinition,
      current._id,
      input.rev,
      input.reason,
      ctx,
      async (session) => {
        const now = new Date();
        const movements: StockMovementDoc[] = [];
        for (const line of current.lines) {
          await changeStock(
            db,
            session,
            {
              location,
              itemId: line.itemId,
              purchaseOrderId: line.purchaseOrderId,
              poLineId: line.poLineId,
            },
            line.quantity,
          );
          if (line.demandLineId) {
            await addToTally(db, session, tallyKey.dispatched(line.demandLineId), -line.quantity);
          }
          movements.push({
            _id: new ObjectId(),
            movementDate: today,
            recordedAt: now,
            type: 'DISPATCH_CANCELLED',
            locationKind: location.kind,
            locationId: location.id,
            itemId: line.itemId,
            purchaseOrderId: line.purchaseOrderId,
            poLineId: line.poLineId,
            quantity: line.quantity,
            source: { kind: 'DISPATCH', id: current._id, code: current.code },
            actor: ctx.actor,
          });
        }
        await insertMovements(db, session, movements);
      },
    )) as DispatchDoc;
    return this.toDetail(cancelled, await this.loadRefs([cancelled]));
  }

  /** Active dispatches dated in the current calendar month (Asia/Karachi). Dashboard indicator. */
  async countThisMonth(): Promise<number> {
    const month = todayInKarachi().slice(0, 7);
    return this.dispatches.countDocuments({
      'lifecycle.state': 'ACTIVE',
      dispatchDate: { $gte: `${month}-01`, $lte: `${month}-31` },
    });
  }

  // ---- helpers ----

  private async findOrThrow(id: string): Promise<DispatchDoc> {
    if (!ObjectId.isValid(id)) throw new NotFoundError('Dispatch not found');
    const doc = await this.dispatches.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new NotFoundError('Dispatch not found');
    return doc;
  }

  private async loadRefs(docs: DispatchDoc[]) {
    const db = this.database.db;
    const [divisions, items, locations] = await Promise.all([
      fetchMasterMap(
        db,
        'divisions',
        docs.map((d) => d.destinationDivisionId.toHexString()),
      ),
      fetchMasterMap(
        db,
        'items',
        docs.flatMap((d) => d.lines.map((l) => l.itemId.toHexString())),
      ),
      loadLocationMaps(
        db,
        docs.map((d) => ({ kind: d.sourceKind, id: d.sourceId })),
      ),
    ]);
    const provinces = await fetchMasterMap(
      db,
      'provinces',
      [...divisions.values()].flatMap((d) => (d.provinceId ? [d.provinceId.toHexString()] : [])),
    );
    return { divisions, items, locations, provinces };
  }

  private toSummary(
    doc: DispatchDoc,
    refs: {
      divisions: RefDocs;
      items: RefDocs;
      provinces: RefDocs;
      locations: { warehouses: RefDocs; divisions: RefDocs };
    },
  ): DispatchSummary {
    const division = refs.divisions.get(doc.destinationDivisionId.toHexString());
    return {
      id: doc._id.toHexString(),
      code: doc.code,
      dispatchDate: doc.dispatchDate,
      status: doc.lifecycle.state === 'ACTIVE' ? 'ACTIVE' : 'CANCELLED',
      source: locationOf(refs.locations, doc.sourceKind, doc.sourceId),
      destinationDivision: {
        ...refOf(refs.divisions, doc.destinationDivisionId),
        provinceName: division?.provinceId
          ? (refs.provinces.get(division.provinceId.toHexString())?.name ?? null)
          : null,
      },
      demand:
        doc.demandId && doc.demandCode
          ? { id: doc.demandId.toHexString(), code: doc.demandCode }
          : null,
      biltyNo: doc.biltyNo,
      transporterName: doc.transporterName,
      vehicleNo: doc.vehicleNo,
      totalQuantity: doc.totalQuantity,
      lineCount: doc.lines.length,
      rev: doc.rev,
      createdAt: doc.createdAt.toISOString(),
      createdBy: actorLabel(doc.createdBy),
    };
  }

  private toDetail(
    doc: DispatchDoc,
    refs: {
      divisions: RefDocs;
      items: RefDocs;
      provinces: RefDocs;
      locations: { warehouses: RefDocs; divisions: RefDocs };
    },
  ): DispatchDetail {
    const { lifecycle } = doc;
    return {
      ...this.toSummary(doc, refs),
      freightAmount: doc.freightAmount,
      notes: doc.notes,
      documents: doc.documents,
      lines: doc.lines.map((line) => ({
        id: line._id.toHexString(),
        lineNo: line.lineNo,
        item: refOf(refs.items, line.itemId),
        lot: {
          purchaseOrderId: line.purchaseOrderId.toHexString(),
          purchaseOrderCode: line.purchaseOrderCode,
          poNumber: line.poNumber,
          poLineId: line.poLineId.toHexString(),
          poLineNo: line.poLineNo,
        },
        quantity: line.quantity,
        demandLine:
          line.demandLineId && doc.demandId && doc.demandCode && line.demandLineNo !== null
            ? {
                demandId: doc.demandId.toHexString(),
                demandCode: doc.demandCode,
                lineNo: line.demandLineNo,
              }
            : null,
      })),
      cancellation:
        lifecycle.state === 'ARCHIVED' && lifecycle.archivedAt
          ? {
              at: lifecycle.archivedAt.toISOString(),
              reason: lifecycle.archiveReason ?? '',
              by: actorLabel(lifecycle.archivedBy),
            }
          : null,
    };
  }
}

function searchTextOf(fields: DispatchFields): string {
  return [
    fields.biltyNo,
    fields.transporterName,
    fields.vehicleNo,
    fields.demandCode,
    fields.notes,
    ...fields.lines.map((l) => l.poNumber),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
