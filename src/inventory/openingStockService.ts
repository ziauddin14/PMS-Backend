import { ObjectId, type Collection, type Filter } from 'mongodb';
import type {
  CancelWithReasonInput,
  OpeningStockCreateInput,
  OpeningStockDetail,
  OpeningStockListQuery,
  OpeningStockListResponse,
  OpeningStockSummary,
} from '../contracts/operations.js';
import type { Database } from '../db/mongo.js';
import { todayInKarachi } from '../demands/demandService.js';
import type { MutationContext } from '../domain/context.js';
import { ConflictError, NotFoundError, ValidationError, type ErrorDetail } from '../errors.js';
import type { MasterRecordDoc } from '../masterData/definitions.js';
import type { RecordStore } from '../records/recordStore.js';
import {
  actorLabel,
  changeStock,
  escapeRegex,
  fetchMasterMap,
  insertMovements,
  refOf,
  type RefDocs,
  type StockMovementDoc,
} from './ledger.js';
import {
  OPENING_STOCK_COLLECTION,
  openingStockDefinition,
  type OpeningStockDoc,
  type OpeningStockFields,
} from './openingStockDefinitions.js';

const EARLIEST_DATE = '2000-01-01';

/**
 * Opening stock: adds goods that are already in a warehouse (from before PMS, or without a PMS
 * purchase order) to warehouse stock. Every line becomes its own lot, which can then be dispatched
 * like a PO lot. Entries are never edited; a wrong entry is cancelled (with reason), which removes
 * its stock again — only while none of it has been dispatched.
 */
export class OpeningStockService {
  constructor(
    private readonly database: Database,
    private readonly store: RecordStore,
  ) {}

  private get entries(): Collection<OpeningStockDoc> {
    return this.database.db.collection<OpeningStockDoc>(OPENING_STOCK_COLLECTION);
  }

  async list(query: OpeningStockListQuery): Promise<OpeningStockListResponse> {
    const filter: Filter<OpeningStockDoc> = {};
    if (query.status === 'open') filter['lifecycle.state'] = 'ACTIVE';
    if (query.status === 'cancelled') filter['lifecycle.state'] = 'ARCHIVED';
    if (query.warehouseId) filter.warehouseId = new ObjectId(query.warehouseId);
    if (query.from || query.to) {
      filter.entryDate = {
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
      this.entries
        .find(filter)
        .sort({ entryDate: -1, code: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .toArray(),
      this.entries.countDocuments(filter),
    ]);
    const refs = await this.loadRefs(docs);
    return {
      items: docs.map((doc) => this.toSummary(doc, refs)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async get(id: string): Promise<OpeningStockDetail> {
    const doc = await this.findOrThrow(id);
    return this.toDetail(doc, await this.loadRefs([doc]));
  }

  async create(input: OpeningStockCreateInput, ctx: MutationContext): Promise<OpeningStockDetail> {
    const db = this.database.db;
    const errors: ErrorDetail[] = [];
    if (input.entryDate < EARLIEST_DATE) {
      errors.push({ path: 'entryDate', message: `Date must be on or after ${EARLIEST_DATE}` });
    } else if (input.entryDate > todayInKarachi()) {
      errors.push({ path: 'entryDate', message: 'Date cannot be in the future' });
    }

    const warehouseId = new ObjectId(input.warehouseId);
    const warehouse = await db.collection<MasterRecordDoc>('warehouses').findOne({
      _id: warehouseId,
    });
    if (!warehouse) {
      errors.push({ path: 'warehouseId', message: 'Warehouse not found' });
    } else if (!warehouse.active) {
      errors.push({ path: 'warehouseId', message: `Warehouse "${warehouse.name}" is inactive` });
    }

    const items = await fetchMasterMap(
      db,
      'items',
      input.lines.map((line) => line.itemId),
    );
    const seen = new Set<string>();
    const lines: OpeningStockFields['lines'] = [];
    for (const [index, line] of input.lines.entries()) {
      const path = `lines.${index}.itemId`;
      const item = items.get(line.itemId);
      if (!item) {
        errors.push({ path, message: 'Item not found' });
        continue;
      }
      if (!item.active) {
        errors.push({ path, message: `Item "${item.name}" is inactive` });
        continue;
      }
      if (seen.has(line.itemId)) {
        errors.push({ path, message: 'This item is listed twice; combine the quantities' });
        continue;
      }
      seen.add(line.itemId);
      lines.push({
        _id: new ObjectId(),
        lineNo: index + 1,
        itemId: item._id,
        quantity: line.quantity,
      });
    }
    if (errors.length > 0) throw new ValidationError(errors);

    const fields: OpeningStockFields = {
      warehouseId,
      entryDate: input.entryDate,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      lines,
      totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
      searchText: [input.reference ?? '', input.notes ?? '']
        .join(' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim(),
    };
    const location = { kind: 'WAREHOUSE' as const, id: warehouseId };

    const created = (await this.store.create(
      openingStockDefinition,
      fields,
      ctx,
      async (session, record) => {
        const now = new Date();
        const movements: StockMovementDoc[] = [];
        for (const line of lines) {
          await changeStock(
            db,
            session,
            { location, itemId: line.itemId, purchaseOrderId: record._id, poLineId: line._id },
            line.quantity,
          );
          movements.push({
            _id: new ObjectId(),
            movementDate: input.entryDate,
            recordedAt: now,
            type: 'OPENING',
            locationKind: 'WAREHOUSE',
            locationId: warehouseId,
            itemId: line.itemId,
            purchaseOrderId: record._id,
            poLineId: line._id,
            quantity: line.quantity,
            source: { kind: 'OPENING', id: record._id, code: record.code },
            actor: ctx.actor,
          });
        }
        await insertMovements(db, session, movements);
      },
    )) as OpeningStockDoc;
    return this.toDetail(created, await this.loadRefs([created]));
  }

  async cancel(
    id: string,
    input: CancelWithReasonInput,
    ctx: MutationContext,
  ): Promise<OpeningStockDetail> {
    const current = await this.findOrThrow(id);
    if (current.lifecycle.state !== 'ACTIVE') {
      throw new ConflictError('This opening stock entry is already cancelled');
    }
    const db = this.database.db;
    const location = { kind: 'WAREHOUSE' as const, id: current.warehouseId };
    const today = todayInKarachi();
    const cancelled = (await this.store.archive(
      openingStockDefinition,
      current._id,
      input.rev,
      input.reason,
      ctx,
      async (session) => {
        const now = new Date();
        const movements: StockMovementDoc[] = [];
        for (const line of current.lines) {
          const lot = {
            location,
            itemId: line.itemId,
            purchaseOrderId: current._id,
            poLineId: line._id,
          };
          if (!(await changeStock(db, session, lot, -line.quantity))) {
            throw new ConflictError(
              `Cannot cancel: stock from line ${line.lineNo} has already been dispatched. Cancel those dispatches first.`,
            );
          }
          movements.push({
            _id: new ObjectId(),
            movementDate: today,
            recordedAt: now,
            type: 'OPENING_CANCELLED',
            locationKind: 'WAREHOUSE',
            locationId: current.warehouseId,
            itemId: line.itemId,
            purchaseOrderId: current._id,
            poLineId: line._id,
            quantity: -line.quantity,
            source: { kind: 'OPENING', id: current._id, code: current.code },
            actor: ctx.actor,
          });
        }
        await insertMovements(db, session, movements);
      },
    )) as OpeningStockDoc;
    return this.toDetail(cancelled, await this.loadRefs([cancelled]));
  }

  // ---- helpers ----

  private async findOrThrow(id: string): Promise<OpeningStockDoc> {
    if (!ObjectId.isValid(id)) throw new NotFoundError('Opening stock entry not found');
    const doc = await this.entries.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new NotFoundError('Opening stock entry not found');
    return doc;
  }

  private async loadRefs(docs: OpeningStockDoc[]) {
    const db = this.database.db;
    const [warehouses, items] = await Promise.all([
      fetchMasterMap(
        db,
        'warehouses',
        docs.map((d) => d.warehouseId.toHexString()),
      ),
      fetchMasterMap(
        db,
        'items',
        docs.flatMap((d) => d.lines.map((l) => l.itemId.toHexString())),
      ),
    ]);
    return { warehouses, items };
  }

  private toSummary(
    doc: OpeningStockDoc,
    refs: { warehouses: RefDocs; items: RefDocs },
  ): OpeningStockSummary {
    return {
      id: doc._id.toHexString(),
      code: doc.code,
      entryDate: doc.entryDate,
      status: doc.lifecycle.state === 'ACTIVE' ? 'ACTIVE' : 'CANCELLED',
      warehouse: refOf(refs.warehouses, doc.warehouseId),
      reference: doc.reference,
      totalQuantity: doc.totalQuantity,
      lineCount: doc.lines.length,
      rev: doc.rev,
      createdAt: doc.createdAt.toISOString(),
      createdBy: actorLabel(doc.createdBy),
    };
  }

  private toDetail(
    doc: OpeningStockDoc,
    refs: { warehouses: RefDocs; items: RefDocs },
  ): OpeningStockDetail {
    const { lifecycle } = doc;
    return {
      ...this.toSummary(doc, refs),
      notes: doc.notes,
      lines: doc.lines.map((line) => ({
        id: line._id.toHexString(),
        lineNo: line.lineNo,
        item: refOf(refs.items, line.itemId),
        quantity: line.quantity,
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
