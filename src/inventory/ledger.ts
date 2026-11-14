import { ObjectId, type ClientSession, type Db } from 'mongodb';
import type { MasterEntityKey, MasterRef } from '../contracts/api.js';
import type { StockLocationKind, StockMovementType } from '../contracts/operations.js';
import { ensureCollection, type CollectionSpec } from '../db/collections.js';
import type { Actor } from '../domain/context.js';
import type { MasterRecordDoc } from '../masterData/definitions.js';

/**
 * Quantity bookkeeping shared by receiving (M7), dispatch (M8) and payments (M9).
 *
 * - `tallies`: one counter per key, changed only with guarded `$inc` so concurrent requests can
 *   never push a total past its limit (received ≤ ordered, dispatched ≤ demanded, paid ≤ approved).
 *   Keys: `rcv:<poLineId>`, `dsp:<demandLineId>`, `pay:<purchaseOrderId>` (paisa/cents).
 * - `stock_balances`: units held per location × PO lot (PO line). Never negative.
 * - `stock_movements`: append-only inventory ledger; every balance change writes one row.
 *
 * All three are written inside the same transaction as the business record (RecordStore
 * side effects), so the ledger, balances and records always agree.
 */
export const TALLIES = 'tallies';
export const STOCK_BALANCES = 'stock_balances';
export const STOCK_MOVEMENTS = 'stock_movements';

export interface TallyDoc {
  _id: string;
  value: number;
  updatedAt: Date;
}

export interface StockLocationRef {
  kind: StockLocationKind;
  id: ObjectId;
}

export interface StockBalanceDoc {
  _id: string;
  locationKind: StockLocationKind;
  locationId: ObjectId;
  itemId: ObjectId;
  purchaseOrderId: ObjectId;
  poLineId: ObjectId;
  quantity: number;
  updatedAt: Date;
}

export interface StockMovementDoc {
  _id: ObjectId;
  movementDate: string;
  recordedAt: Date;
  type: StockMovementType;
  locationKind: StockLocationKind;
  locationId: ObjectId;
  itemId: ObjectId;
  purchaseOrderId: ObjectId;
  poLineId: ObjectId;
  quantity: number;
  source: { kind: 'RECEIPT' | 'DISPATCH'; id: ObjectId; code: string };
  actor: Actor;
}

export const tallyKey = {
  received: (poLineId: ObjectId) => `rcv:${poLineId.toHexString()}`,
  dispatched: (demandLineId: ObjectId) => `dsp:${demandLineId.toHexString()}`,
  paidCents: (purchaseOrderId: ObjectId) => `pay:${purchaseOrderId.toHexString()}`,
};

export function stockKey(location: StockLocationRef, poLineId: ObjectId): string {
  return `${location.kind}:${location.id.toHexString()}:${poLineId.toHexString()}`;
}

/**
 * Adds `delta` to a tally. Positive deltas fail (return false) if the result would exceed `max`;
 * negative deltas fail if the result would go below zero.
 */
export async function addToTally(
  db: Db,
  session: ClientSession | undefined,
  key: string,
  delta: number,
  max?: number,
): Promise<boolean> {
  const tallies = db.collection<TallyDoc>(TALLIES);
  const now = new Date();
  if (delta > 0) {
    await tallies.updateOne(
      { _id: key },
      { $setOnInsert: { value: 0, updatedAt: now } },
      { upsert: true, session },
    );
  }
  const guard =
    delta > 0
      ? max === undefined
        ? {}
        : { value: { $lte: max - delta } }
      : { value: { $gte: -delta } };
  const result = await tallies.updateOne(
    { _id: key, ...guard },
    { $inc: { value: delta }, $set: { updatedAt: now } },
    { session },
  );
  return result.matchedCount === 1;
}

export async function readTallies(db: Db, keys: string[]): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();
  const docs = await db
    .collection<TallyDoc>(TALLIES)
    .find({ _id: { $in: keys } })
    .toArray();
  return new Map(docs.map((doc) => [doc._id, doc.value]));
}

/** Changes a stock balance; a decrease fails (returns false) if it would go below zero. */
export async function changeStock(
  db: Db,
  session: ClientSession | undefined,
  lot: {
    location: StockLocationRef;
    itemId: ObjectId;
    purchaseOrderId: ObjectId;
    poLineId: ObjectId;
  },
  delta: number,
): Promise<boolean> {
  const balances = db.collection<StockBalanceDoc>(STOCK_BALANCES);
  const _id = stockKey(lot.location, lot.poLineId);
  const now = new Date();
  if (delta > 0) {
    await balances.updateOne(
      { _id },
      {
        $setOnInsert: {
          locationKind: lot.location.kind,
          locationId: lot.location.id,
          itemId: lot.itemId,
          purchaseOrderId: lot.purchaseOrderId,
          poLineId: lot.poLineId,
          quantity: 0,
        },
        $set: { updatedAt: now },
      },
      { upsert: true, session },
    );
  }
  const result = await balances.updateOne(
    delta > 0 ? { _id } : { _id, quantity: { $gte: -delta } },
    { $inc: { quantity: delta }, $set: { updatedAt: now } },
    { session },
  );
  return result.matchedCount === 1;
}

export async function getStockBalance(
  db: Db,
  location: StockLocationRef,
  poLineId: ObjectId,
): Promise<number> {
  const doc = await db
    .collection<StockBalanceDoc>(STOCK_BALANCES)
    .findOne({ _id: stockKey(location, poLineId) });
  return doc?.quantity ?? 0;
}

export async function insertMovements(
  db: Db,
  session: ClientSession | undefined,
  movements: StockMovementDoc[],
): Promise<void> {
  if (movements.length === 0) return;
  await db.collection<StockMovementDoc>(STOCK_MOVEMENTS).insertMany(movements, { session });
}

const ledgerSpecs: CollectionSpec[] = [
  {
    name: TALLIES,
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'value'],
        properties: {
          _id: { bsonType: 'string' },
          value: { bsonType: ['int', 'long', 'double'], minimum: 0 },
        },
      },
    },
    indexes: [],
  },
  {
    name: STOCK_BALANCES,
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          '_id',
          'locationKind',
          'locationId',
          'itemId',
          'purchaseOrderId',
          'poLineId',
          'quantity',
        ],
        properties: {
          _id: { bsonType: 'string' },
          locationKind: { enum: ['WAREHOUSE', 'DIVISION'] },
          locationId: { bsonType: 'objectId' },
          itemId: { bsonType: 'objectId' },
          purchaseOrderId: { bsonType: 'objectId' },
          poLineId: { bsonType: 'objectId' },
          quantity: { bsonType: ['int', 'long', 'double'], minimum: 0 },
        },
      },
    },
    indexes: [
      { key: { locationKind: 1, locationId: 1, itemId: 1 }, name: 'location_item' },
      { key: { itemId: 1 }, name: 'item' },
      { key: { purchaseOrderId: 1 }, name: 'purchaseOrder' },
    ],
  },
  {
    name: STOCK_MOVEMENTS,
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          'movementDate',
          'recordedAt',
          'type',
          'locationKind',
          'locationId',
          'itemId',
          'purchaseOrderId',
          'poLineId',
          'quantity',
          'source',
          'actor',
        ],
        properties: {
          movementDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          recordedAt: { bsonType: 'date' },
          type: { enum: ['RECEIPT', 'RECEIPT_CANCELLED', 'DISPATCH', 'DISPATCH_CANCELLED'] },
          locationKind: { enum: ['WAREHOUSE', 'DIVISION'] },
          quantity: { bsonType: ['int', 'long', 'double'] },
        },
      },
    },
    indexes: [
      { key: { movementDate: -1, recordedAt: -1 }, name: 'date' },
      { key: { locationKind: 1, locationId: 1, movementDate: -1 }, name: 'location_date' },
      { key: { itemId: 1, movementDate: -1 }, name: 'item_date' },
      { key: { purchaseOrderId: 1 }, name: 'purchaseOrder' },
      { key: { 'source.id': 1 }, name: 'source' },
    ],
  },
];

export async function ensureLedgerCollections(db: Db): Promise<void> {
  for (const spec of ledgerSpecs) await ensureCollection(db, spec);
}

// ---- shared reference helpers ----

export type RefDocs = Map<string, MasterRecordDoc>;

export async function fetchMasterMap(
  db: Db,
  entity: MasterEntityKey,
  ids: Iterable<string>,
): Promise<RefDocs> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const docs = await db
    .collection<MasterRecordDoc>(entity)
    .find({ _id: { $in: unique.map((id) => new ObjectId(id)) } })
    .toArray();
  return new Map(docs.map((doc) => [doc._id.toHexString(), doc]));
}

export function refOf(map: RefDocs | undefined, id: ObjectId): MasterRef {
  const doc = map?.get(id.toHexString());
  if (!doc) return { id: id.toHexString(), code: '', name: '(missing record)', active: false };
  return { id: doc._id.toHexString(), code: doc.code, name: doc.name, active: doc.active };
}

/** Loads warehouses and divisions for a set of stock locations. */
export async function loadLocationMaps(
  db: Db,
  locations: Array<{ kind: StockLocationKind; id: ObjectId }>,
): Promise<{ warehouses: RefDocs; divisions: RefDocs }> {
  const [warehouses, divisions] = await Promise.all([
    fetchMasterMap(
      db,
      'warehouses',
      locations.filter((l) => l.kind === 'WAREHOUSE').map((l) => l.id.toHexString()),
    ),
    fetchMasterMap(
      db,
      'divisions',
      locations.filter((l) => l.kind === 'DIVISION').map((l) => l.id.toHexString()),
    ),
  ]);
  return { warehouses, divisions };
}

export function locationOf(
  maps: { warehouses: RefDocs; divisions: RefDocs },
  kind: StockLocationKind,
  id: ObjectId,
) {
  const ref = refOf(kind === 'WAREHOUSE' ? maps.warehouses : maps.divisions, id);
  return { kind, ...ref };
}

export function actorLabel(actor: Actor | null | undefined): string | null {
  return actor?.label ?? actor?.id ?? null;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function toCents(amount: number): number {
  return Math.round(amount * 100);
}
