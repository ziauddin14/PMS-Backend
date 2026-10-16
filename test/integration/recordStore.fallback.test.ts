import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import {
  COLLECTIONS,
  ensureCollection,
  ensureInfrastructureCollections,
  recordCollectionSpec,
} from '../../src/db/collections.js';
import { connectToDatabase, type Database } from '../../src/db/mongo.js';
import { RecordStore } from '../../src/records/recordStore.js';
import { silentLogger, syntheticWidgets, testActor, testConfig } from '../helpers.js';
import { startStandalone } from './memoryMongo.js';

let server: MongoMemoryServer;
let database: Database;
let store: RecordStore;
const ctx = { actor: testActor };

beforeAll(async () => {
  server = await startStandalone();
  const config = testConfig({
    MONGODB_URI: server.getUri(),
    MONGODB_DB_NAME: 'pms_fallback_test',
    MONGODB_REQUIRE_TRANSACTIONS: 'false',
  });
  database = await connectToDatabase(config.mongodb, silentLogger);
  store = new RecordStore(database);
});

afterAll(async () => {
  await database?.close();
  await server?.stop();
});

beforeEach(async () => {
  await database.db.dropDatabase();
  await ensureInfrastructureCollections(database.db);
  await ensureCollection(database.db, recordCollectionSpec(syntheticWidgets.collection));
});

describe('RecordStore without transactions (development fallback)', () => {
  it('marks audit events as non-atomic but committed when everything succeeds', async () => {
    expect(database.supportsTransactions).toBe(false);
    const record = await store.create(syntheticWidgets, { name: 'Synthetic', quantity: 1 }, ctx);
    const event = await database.db
      .collection(COLLECTIONS.auditEvents)
      .findOne({ 'entity.id': record._id });
    expect(event).toMatchObject({ state: 'COMMITTED', atomic: false });
    expect(await store.findIncompleteAuditEvents()).toHaveLength(0);
  });

  it('records a FAILED audit event when the record write fails', async () => {
    const record = await store.create(syntheticWidgets, { name: 'Synthetic', quantity: 1 }, ctx);
    // Force the next record insert to fail: reset the counter so the next code is a duplicate.
    await database.db
      .collection<{ _id: string; seq: number }>(COLLECTIONS.counters)
      .updateOne({ _id: 'TST' }, { $set: { seq: 0 } });
    await expect(
      store.create(syntheticWidgets, { name: 'Duplicate code', quantity: 1 }, ctx),
    ).rejects.toThrow(/duplicate key/);
    const incomplete = await store.findIncompleteAuditEvents();
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toMatchObject({ state: 'FAILED', action: 'CREATE' });
    expect(incomplete[0]?.failureReason).toMatch(/Record write failed/);
    expect(await database.db.collection(syntheticWidgets.collection).countDocuments()).toBe(1);
    expect(record.code).toBe('TST-000001');
  });

  it('leaves a PENDING audit event for reconciliation when a step after the record write fails', async () => {
    const record = await store.create(syntheticWidgets, { name: 'Synthetic', quantity: 1 }, ctx);
    await database.db.collection(COLLECTIONS.syncJobs).insertOne({
      idempotencyKey: `synthetic_widgets:${record._id.toHexString()}:2:SYNTHETIC_WORKBOOK:Synthetic Sheet`,
      direction: 'OUTBOUND',
      target: { workbook: 'SYNTHETIC_WORKBOOK' },
      entity: { collection: 'synthetic_widgets', id: record._id, code: record.code },
      entityRev: 2,
      operation: 'UPDATE',
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      store.update(syntheticWidgets, record._id, 1, { quantity: 5 }, ctx),
    ).rejects.toThrow(/duplicate key/);
    const incomplete = await store.findIncompleteAuditEvents();
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toMatchObject({ state: 'PENDING', action: 'UPDATE' });
    expect(incomplete[0]?.failureReason).toMatch(/reconcile/);
    // Not atomic: the record change itself was written.
    expect(
      (await database.db.collection(syntheticWidgets.collection).findOne({ _id: record._id }))?.rev,
    ).toBe(2);
  });
});
