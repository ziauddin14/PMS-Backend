import { ObjectId, type Collection, type Filter } from 'mongodb';
import type {
  CancelWithReasonInput,
  ReceiptCreateInput,
  ReceiptDetail,
  ReceiptListQuery,
  ReceiptListResponse,
  ReceiptSummary,
} from '../contracts/operations.js';
import type { Database } from '../db/mongo.js';
import { todayInKarachi } from '../demands/demandService.js';
import type { MutationContext } from '../domain/context.js';
import { ConflictError, NotFoundError, ValidationError, type ErrorDetail } from '../errors.js';
import {
  PURCHASE_ORDERS_COLLECTION,
  type PurchaseOrderDoc,
} from '../purchaseOrders/definitions.js';
import type { RecordStore } from '../records/recordStore.js';
import {
  actorLabel,
  addToTally,
  changeStock,
  escapeRegex,
  fetchMasterMap,
  insertMovements,
  loadLocationMaps,
  locationOf,
  readTallies,
  refOf,
  tallyKey,
  type RefDocs,
  type StockMovementDoc,
} from './ledger.js';
import {
  RECEIPTS_COLLECTION,
  receiptDefinition,
  type ReceiptDoc,
  type ReceiptFields,
} from './receiptDefinitions.js';

/**
 * Goods receiving (M7). A receipt records vendor goods arriving against PO lines:
 * - WAREHOUSE route: stock goes into the PO's target warehouse (warehouse stock).
 * - DIRECT route: goods are received at the destination division and held there as division
 *   stock — they are never counted as warehouse stock.
 * Received quantities can never exceed ordered quantities (guarded tally per PO line, enforced in
 * the same transaction), so duplicate submissions or concurrent receipts cannot double-count.
 * Receipts are never edited; a wrong receipt is cancelled (with reason), which reverses its stock
 * movements — only while that stock has not been dispatched.
 */
export class ReceiptService {
  constructor(
    private readonly database: Database,
    private readonly store: RecordStore,
  ) {}

  private get receipts(): Collection<ReceiptDoc> {
    return this.database.db.collection<ReceiptDoc>(RECEIPTS_COLLECTION);
  }

  private get purchaseOrders(): Collection<PurchaseOrderDoc> {
    return this.database.db.collection<PurchaseOrderDoc>(PURCHASE_ORDERS_COLLECTION);
  }

  async list(query: ReceiptListQuery): Promise<ReceiptListResponse> {
    const filter: Filter<ReceiptDoc> = {};
    if (query.status === 'open') filter['lifecycle.state'] = 'ACTIVE';
    if (query.status === 'cancelled') filter['lifecycle.state'] = 'ARCHIVED';
    if (query.purchaseOrderId) filter.purchaseOrderId = new ObjectId(query.purchaseOrderId);
    if (query.vendorId) filter.vendorId = new ObjectId(query.vendorId);
    if (query.from || query.to) {
      filter.receiptDate = {
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
      this.receipts
        .find(filter)
        .sort({ receiptDate: -1, code: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .toArray(),
      this.receipts.countDocuments(filter),
    ]);
    const refs = await this.loadRefs(docs);
    return {
      items: docs.map((doc) => this.toSummary(doc, refs)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async get(id: string): Promise<ReceiptDetail> {
    const doc = await this.findOrThrow(id);
    return this.toDetail(doc, await this.loadRefs([doc]));
  }

  async create(input: ReceiptCreateInput, ctx: MutationContext): Promise<ReceiptDetail> {
    const errors: ErrorDetail[] = [];
    const po = ObjectId.isValid(input.purchaseOrderId)
      ? await this.purchaseOrders.findOne({ _id: new ObjectId(input.purchaseOrderId) })
      : null;
    if (!po) {
      throw new ValidationError([{ path: 'purchaseOrderId', message: 'Purchase order not found' }]);
    }
    if (po.lifecycle.state !== 'ACTIVE') {
      throw new ConflictError('This purchase order is cancelled; goods cannot be received');
    }
    if (input.receiptDate > todayInKarachi()) {
      errors.push({ path: 'receiptDate', message: 'Date cannot be in the future' });
    } else if (input.receiptDate < po.poDate) {
      errors.push({
        path: 'receiptDate',
        message: `Date cannot be before the PO date (${po.poDate})`,
      });
    }

    const location =
      po.deliveryRoute === 'WAREHOUSE'
        ? { kind: 'WAREHOUSE' as const, id: po.targetWarehouseId }
        : { kind: 'DIVISION' as const, id: po.destinationDivisionId };
    if (!location.id) {
      throw new ConflictError(
        'The purchase order has no receiving location; fix the PO route first',
      );
    }
    const locationRef = { kind: location.kind, id: location.id };

    const poLines = new Map(po.lines.map((line) => [line._id.toHexString(), line]));
    const received = await readTallies(
      this.database.db,
      po.lines.map((line) => tallyKey.received(line._id)),
    );
    const seen = new Set<string>();
    const lines: ReceiptFields['lines'] = [];
    for (const [index, line] of input.lines.entries()) {
      const path = `lines.${index}`;
      const poLine = poLines.get(line.poLineId);
      if (!poLine) {
        errors.push({
          path: `${path}.poLineId`,
          message: 'Line does not belong to this purchase order',
        });
        continue;
      }
      if (seen.has(line.poLineId)) {
        errors.push({ path: `${path}.poLineId`, message: 'This PO line is listed twice' });
        continue;
      }
      seen.add(line.poLineId);
      const remaining = poLine.quantityOrdered - (received.get(tallyKey.received(poLine._id)) ?? 0);
      if (line.quantity > remaining) {
        errors.push({
          path: `${path}.quantity`,
          message: `Only ${remaining} unit(s) remain to be received on PO line ${poLine.lineNo}`,
        });
      }
      lines.push({
        _id: new ObjectId(),
        poLineId: poLine._id,
        poLineNo: poLine.lineNo,
        itemId: poLine.itemId,
        quantity: line.quantity,
      });
    }
    if (errors.length > 0) throw new ValidationError(errors);

    const fields: ReceiptFields = {
      purchaseOrderId: po._id,
      purchaseOrderCode: po.code,
      poNumber: po.poNumber,
      vendorId: po.vendorId,
      deliveryRoute: po.deliveryRoute,
      locationKind: location.kind,
      locationId: location.id,
      receiptDate: input.receiptDate,
      vendorChallanNo: input.vendorChallanNo ?? null,
      notes: input.notes ?? null,
      documents: input.documents.map((d) => ({ label: d.label, url: d.url })),
      lines,
      totalQuantity: lines.reduce((sum, line) => sum + line.quantity, 0),
      searchText: [po.poNumber, po.code, input.vendorChallanNo ?? '', input.notes ?? '']
        .join(' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim(),
    };

    const db = this.database.db;
    const created = (await this.store.create(
      receiptDefinition,
      fields,
      ctx,
      async (session, record) => {
        // Guarded per-line tallies: a concurrent receipt that would over-receive aborts here.
        const now = new Date();
        const movements: StockMovementDoc[] = [];
        for (const line of lines) {
          const poLine = poLines.get(line.poLineId.toHexString())!;
          const ok = await addToTally(
            db,
            session,
            tallyKey.received(line.poLineId),
            line.quantity,
            poLine.quantityOrdered,
          );
          if (!ok) {
            throw new ConflictError(
              `PO line ${poLine.lineNo} would be over-received (someone else may have just recorded a receipt); reload and try again`,
            );
          }
          const lot = {
            location: locationRef,
            itemId: line.itemId,
            purchaseOrderId: po._id,
            poLineId: line.poLineId,
          };
          await changeStock(db, session, lot, line.quantity);
          movements.push({
            _id: new ObjectId(),
            movementDate: input.receiptDate,
            recordedAt: now,
            type: 'RECEIPT',
            locationKind: locationRef.kind,
            locationId: locationRef.id,
            itemId: line.itemId,
            purchaseOrderId: po._id,
            poLineId: line.poLineId,
            quantity: line.quantity,
            source: { kind: 'RECEIPT', id: record._id, code: record.code },
            actor: ctx.actor,
          });
        }
        await insertMovements(db, session, movements);
      },
    )) as ReceiptDoc;
    return this.toDetail(created, await this.loadRefs([created]));
  }

  async cancel(
    id: string,
    input: CancelWithReasonInput,
    ctx: MutationContext,
  ): Promise<ReceiptDetail> {
    const current = await this.findOrThrow(id);
    if (current.lifecycle.state !== 'ACTIVE') {
      throw new ConflictError('This receipt is already cancelled');
    }
    const db = this.database.db;
    const locationRef = { kind: current.locationKind, id: current.locationId };
    const today = todayInKarachi();
    const cancelled = (await this.store.archive(
      receiptDefinition,
      current._id,
      input.rev,
      input.reason,
      ctx,
      async (session) => {
        const now = new Date();
        const movements: StockMovementDoc[] = [];
        for (const line of current.lines) {
          const lot = {
            location: locationRef,
            itemId: line.itemId,
            purchaseOrderId: current.purchaseOrderId,
            poLineId: line.poLineId,
          };
          if (!(await changeStock(db, session, lot, -line.quantity))) {
            throw new ConflictError(
              `Cannot cancel: stock from PO line ${line.poLineNo} has already been dispatched. Cancel those dispatches first.`,
            );
          }
          if (!(await addToTally(db, session, tallyKey.received(line.poLineId), -line.quantity))) {
            throw new ConflictError('Received quantity tally is inconsistent; contact support');
          }
          movements.push({
            _id: new ObjectId(),
            movementDate: today,
            recordedAt: now,
            type: 'RECEIPT_CANCELLED',
            locationKind: locationRef.kind,
            locationId: locationRef.id,
            itemId: line.itemId,
            purchaseOrderId: current.purchaseOrderId,
            poLineId: line.poLineId,
            quantity: -line.quantity,
            source: { kind: 'RECEIPT', id: current._id, code: current.code },
            actor: ctx.actor,
          });
        }
        await insertMovements(db, session, movements);
      },
    )) as ReceiptDoc;
    return this.toDetail(cancelled, await this.loadRefs([cancelled]));
  }

  // ---- helpers ----

  private async findOrThrow(id: string): Promise<ReceiptDoc> {
    if (!ObjectId.isValid(id)) throw new NotFoundError('Receipt not found');
    const doc = await this.receipts.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new NotFoundError('Receipt not found');
    return doc;
  }

  private async loadRefs(docs: ReceiptDoc[]) {
    const db = this.database.db;
    const [vendors, items, locations] = await Promise.all([
      fetchMasterMap(
        db,
        'vendors',
        docs.map((d) => d.vendorId.toHexString()),
      ),
      fetchMasterMap(
        db,
        'items',
        docs.flatMap((d) => d.lines.map((l) => l.itemId.toHexString())),
      ),
      loadLocationMaps(
        db,
        docs.map((d) => ({ kind: d.locationKind, id: d.locationId })),
      ),
    ]);
    return { vendors, items, locations };
  }

  private toSummary(
    doc: ReceiptDoc,
    refs: {
      vendors: RefDocs;
      items: RefDocs;
      locations: { warehouses: RefDocs; divisions: RefDocs };
    },
  ): ReceiptSummary {
    return {
      id: doc._id.toHexString(),
      code: doc.code,
      receiptDate: doc.receiptDate,
      status: doc.lifecycle.state === 'ACTIVE' ? 'ACTIVE' : 'CANCELLED',
      purchaseOrder: {
        id: doc.purchaseOrderId.toHexString(),
        code: doc.purchaseOrderCode,
        poNumber: doc.poNumber,
      },
      vendor: refOf(refs.vendors, doc.vendorId),
      deliveryRoute: doc.deliveryRoute,
      location: locationOf(refs.locations, doc.locationKind, doc.locationId),
      vendorChallanNo: doc.vendorChallanNo,
      totalQuantity: doc.totalQuantity,
      lineCount: doc.lines.length,
      rev: doc.rev,
      createdAt: doc.createdAt.toISOString(),
      createdBy: actorLabel(doc.createdBy),
    };
  }

  private toDetail(
    doc: ReceiptDoc,
    refs: {
      vendors: RefDocs;
      items: RefDocs;
      locations: { warehouses: RefDocs; divisions: RefDocs };
    },
  ): ReceiptDetail {
    const { lifecycle } = doc;
    return {
      ...this.toSummary(doc, refs),
      notes: doc.notes,
      documents: doc.documents ?? [],
      lines: doc.lines.map((line) => ({
        id: line._id.toHexString(),
        poLineId: line.poLineId.toHexString(),
        poLineNo: line.poLineNo,
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
