import { ObjectId, type Filter } from 'mongodb';
import type {
  StockBalanceQuery,
  StockBalanceResponse,
  StockMovementQuery,
  StockMovementResponse,
} from '../contracts/operations.js';
import type { Database } from '../db/mongo.js';
import {
  STOCK_BALANCES,
  STOCK_MOVEMENTS,
  actorLabel,
  fetchMasterMap,
  loadLocationMaps,
  locationOf,
  refOf,
  type StockBalanceDoc,
  type StockMovementDoc,
} from './ledger.js';
import { lotRefOf, resolveLots } from './lots.js';

/** Read-only stock views (M7): balances by location × item × PO lot, and the movement ledger. */
export class StockService {
  constructor(private readonly database: Database) {}

  async balances(query: StockBalanceQuery): Promise<StockBalanceResponse> {
    const filter: Filter<StockBalanceDoc> = {};
    if (query.locationKind) filter.locationKind = query.locationKind;
    if (query.locationId) filter.locationId = new ObjectId(query.locationId);
    if (query.itemId) filter.itemId = new ObjectId(query.itemId);
    if (query.purchaseOrderId) filter.purchaseOrderId = new ObjectId(query.purchaseOrderId);
    if (query.includeZero !== 'true') filter.quantity = { $gt: 0 };
    const collection = this.database.db.collection<StockBalanceDoc>(STOCK_BALANCES);
    const [docs, total, sum] = await Promise.all([
      collection
        .find(filter)
        .sort({ locationKind: -1, locationId: 1, itemId: 1, _id: 1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .toArray(),
      collection.countDocuments(filter),
      collection
        .aggregate<{ total: number }>([
          { $match: filter },
          { $group: { _id: null, total: { $sum: '$quantity' } } },
        ])
        .toArray(),
    ]);
    const refs = await this.loadRefs(docs);
    return {
      items: docs.map((doc) => ({
        location: locationOf(refs.locations, doc.locationKind, doc.locationId),
        item: refOf(refs.items, doc.itemId),
        lot: refs.lotOf(doc.purchaseOrderId, doc.poLineId),
        quantity: doc.quantity,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalQuantity: sum[0]?.total ?? 0,
    };
  }

  async movements(query: StockMovementQuery): Promise<StockMovementResponse> {
    const filter: Filter<StockMovementDoc> = {};
    if (query.locationKind) filter.locationKind = query.locationKind;
    if (query.locationId) filter.locationId = new ObjectId(query.locationId);
    if (query.itemId) filter.itemId = new ObjectId(query.itemId);
    if (query.purchaseOrderId) filter.purchaseOrderId = new ObjectId(query.purchaseOrderId);
    if (query.type) filter.type = query.type;
    if (query.from || query.to) {
      filter.movementDate = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }
    const collection = this.database.db.collection<StockMovementDoc>(STOCK_MOVEMENTS);
    const [docs, total] = await Promise.all([
      collection
        .find(filter)
        .sort({ movementDate: -1, recordedAt: -1, _id: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    const refs = await this.loadRefs(docs);
    return {
      items: docs.map((doc) => ({
        id: doc._id.toHexString(),
        movementDate: doc.movementDate,
        recordedAt: doc.recordedAt.toISOString(),
        type: doc.type,
        location: locationOf(refs.locations, doc.locationKind, doc.locationId),
        item: refOf(refs.items, doc.itemId),
        lot: refs.lotOf(doc.purchaseOrderId, doc.poLineId),
        quantity: doc.quantity,
        source: { kind: doc.source.kind, id: doc.source.id.toHexString(), code: doc.source.code },
        by: actorLabel(doc.actor),
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  /** Units in warehouses only (dashboard). Direct-route division stock is excluded by design. */
  async warehouseUnits(): Promise<number> {
    const [result] = await this.database.db
      .collection<StockBalanceDoc>(STOCK_BALANCES)
      .aggregate<{ total: number }>([
        { $match: { locationKind: 'WAREHOUSE' } },
        { $group: { _id: null, total: { $sum: '$quantity' } } },
      ])
      .toArray();
    return result?.total ?? 0;
  }

  private async loadRefs(
    docs: Array<{
      locationKind: 'WAREHOUSE' | 'DIVISION';
      locationId: ObjectId;
      itemId: ObjectId;
      purchaseOrderId: ObjectId;
      poLineId: ObjectId;
    }>,
  ) {
    const db = this.database.db;
    const [items, locations, lots] = await Promise.all([
      fetchMasterMap(
        db,
        'items',
        docs.map((d) => d.itemId.toHexString()),
      ),
      loadLocationMaps(
        db,
        docs.map((d) => ({ kind: d.locationKind, id: d.locationId })),
      ),
      resolveLots(
        db,
        docs.map((d) => d.poLineId),
      ),
    ]);
    const lotOf = (purchaseOrderId: ObjectId, poLineId: ObjectId) =>
      lotRefOf(lots, purchaseOrderId, poLineId);
    return { items, locations, lotOf };
  }
}
