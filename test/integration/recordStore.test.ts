import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { isRecordCode } from '../../src/contracts/codes.js';
import {
  COLLECTIONS,
  ensureCollection,
  ensureInfrastructureCollections,
  recordCollectionSpec,
} from '../../src/db/collections.js';
import { connectToDatabase, type Database } from '../../src/db/mongo.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/errors.js';
import { RecordStore } from '../../src/records/recordStore.js';
import { silentLogger, syntheticWidgets, testActor, testConfig } from '../helpers.js';
import { startReplicaSet } from './memoryMongo.js';

let replSet: MongoMemoryReplSet;
let database: Database;
let store: RecordStore;

beforeAll(async () => {
  replSet = await startReplicaSet();
  const config = testConfig({ MONGODB_URI: replSet.getUri(), MONGODB_DB_NAME: 'pms_record_test' });
  database = await connectToDatabase(config.mongodb, silentLogger);
  store = new RecordStore(database);
});

afterAll(async () => {
  await database?.close();
  await replSet?.stop();
});

beforeEach(async () => {
  await database.db.dropDatabase();
  await ensureInfrastructureCollections(database.db);
  await ensureCollection(database.db, recordCollectionSpec(syntheticWidgets.collection));
});

const ctx = { actor: testActor, correlationId: 'synthetic-correlation' };
const audits = () => database.db.collection(COLLECTIONS.auditEvents);
const jobs = () => database.db.collection(COLLECTIONS.syncJobs);
const widgets = () => database.db.collection(syntheticWidgets.collection);

describe('RecordStore with transactions', () => {
  it('creates a record with permanent id, code, rev 1, timestamps and lifecycle', async () => {
    const record = await store.create(syntheticWidgets, { name: 'Synthetic A', quantity: 5 }, ctx);
    expect(record._id).toBeInstanceOf(ObjectId);
    expect(isRecordCode(record.code)).toBe(true);
    expect(record.code).toBe('TST-000001');
    expect(record.rev).toBe(1);
    expect(record.createdAt).toBeInstanceOf(Date);
    expect(record.lifecycle.state).toBe('ACTIVE');
    expect(record.createdBy).toEqual(testActor);

    const stored = await widgets().findOne({ _id: record._id });
    expect(stored).toMatchObject({ name: 'Synthetic A', quantity: 5, rev: 1, code: 'TST-000001' });
  });

  it('writes a committed, atomic audit event and an outbound sync job', async () => {
    const record = await store.create(syntheticWidgets, { name: 'Synthetic B', quantity: 1 }, ctx);
    const events = await audits().find({ 'entity.id': record._id }).toArray();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'CREATE',
      state: 'COMMITTED',
      atomic: true,
      revBefore: null,
      revAfter: 1,
      correlationId: 'synthetic-correlation',
      entity: { collection: 'synthetic_widgets', code: record.code },
    });
    expect(events[0]?.changes).toEqual(
      expect.arrayContaining([{ field: 'name', before: null, after: 'Synthetic B' }]),
    );

    const queued = await jobs().find({ 'entity.id': record._id }).toArray();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      direction: 'OUTBOUND',
      status: 'PENDING',
      operation: 'CREATE',
      entityRev: 1,
      target: { workbook: 'SYNTHETIC_WORKBOOK', sheet: 'Synthetic Sheet' },
    });
  });

  it('validates input before persistence and rejects system-managed fields', async () => {
    await expect(
      store.create(syntheticWidgets, { name: '', quantity: -1 }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.create(syntheticWidgets, { name: 'X', quantity: 1, rev: 99 }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.create(syntheticWidgets, { name: 'X', quantity: 1, unexpected: 'field' }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.create(syntheticWidgets, { name: 'X', quantity: 1 }, { actor: { type: 'USER' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await widgets().countDocuments()).toBe(0);
    expect(await audits().countDocuments()).toBe(0);
    expect(await jobs().countDocuments()).toBe(0);
  });

  it('generates unique codes under concurrency and never reuses them', async () => {
    const created = await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.create(syntheticWidgets, { name: `Synthetic ${i}`, quantity: i }, ctx),
      ),
    );
    const codes = new Set(created.map((r) => r.code));
    expect(codes.size).toBe(25);
    const first = created[0];
    if (!first) throw new Error('no record');
    await store.archive(syntheticWidgets, first._id, 1, 'synthetic cleanup', ctx);
    const next = await store.create(syntheticWidgets, { name: 'After archive', quantity: 0 }, ctx);
    expect(codes.has(next.code)).toBe(false);
    expect(next.code).toBe('TST-000026');
  });

  it('updates with optimistic concurrency and audits only changed fields', async () => {
    const record = await store.create(syntheticWidgets, { name: 'Synthetic C', quantity: 2 }, ctx);
    const updated = await store.update(
      syntheticWidgets,
      record._id,
      1,
      { quantity: 7, name: 'Synthetic C' },
      ctx,
    );
    expect(updated.rev).toBe(2);
    expect(updated.quantity).toBe(7);

    const event = await audits().findOne({ 'entity.id': record._id, action: 'UPDATE' });
    expect(event?.changes).toEqual([{ field: 'quantity', before: 2, after: 7 }]);
    expect(event).toMatchObject({ revBefore: 1, revAfter: 2, state: 'COMMITTED' });
    expect(await jobs().countDocuments({ 'entity.id': record._id, entityRev: 2 })).toBe(1);
  });

  it('rejects stale revisions without writing anything', async () => {
    const record = await store.create(syntheticWidgets, { name: 'Synthetic D', quantity: 1 }, ctx);
    await store.update(syntheticWidgets, record._id, 1, { quantity: 2 }, ctx);
    await expect(
      store.update(syntheticWidgets, record._id, 1, { quantity: 3 }, ctx),
    ).rejects.toBeInstanceOf(ConflictError);
    expect((await widgets().findOne({ _id: record._id }))?.quantity).toBe(2);
    expect(await audits().countDocuments({ 'entity.id': record._id })).toBe(2);
  });

  it('lets exactly one of two concurrent updates with the same revision win', async () => {
    const record = await store.create(syntheticWidgets, { name: 'Synthetic E', quantity: 1 }, ctx);
    const results = await Promise.allSettled([
      store.update(syntheticWidgets, record._id, 1, { quantity: 10 }, ctx),
      store.update(syntheticWidgets, record._id, 1, { quantity: 20 }, ctx),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    const stored = await widgets().findOne({ _id: record._id });
    expect(stored?.rev).toBe(2);
    expect(await audits().countDocuments({ 'entity.id': record._id, action: 'UPDATE' })).toBe(1);
  });

  it('does not bump the revision for a no-op update', async () => {
    const record = await store.create(syntheticWidgets, { name: 'Synthetic F', quantity: 4 }, ctx);
    const same = await store.update(syntheticWidgets, record._id, 1, { quantity: 4 }, ctx);
    expect(same.rev).toBe(1);
    expect(await audits().countDocuments({ 'entity.id': record._id })).toBe(1);
  });

  it('archives instead of deleting and blocks further edits', async () => {
    const record = await store.create(syntheticWidgets, { name: 'Synthetic G', quantity: 1 }, ctx);
    const archived = await store.archive(syntheticWidgets, record._id, 1, 'synthetic reason', ctx);
    expect(archived.lifecycle).toMatchObject({
      state: 'ARCHIVED',
      archiveReason: 'synthetic reason',
    });
    expect(await widgets().countDocuments({ _id: record._id })).toBe(1);
    await expect(
      store.update(syntheticWidgets, record._id, 2, { quantity: 5 }, ctx),
    ).rejects.toThrow(/archived/);
    await expect(store.archive(syntheticWidgets, record._id, 2, '  ', ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect('delete' in store).toBe(false);
  });

  it('reports unknown records as not found', async () => {
    await expect(
      store.update(syntheticWidgets, new ObjectId(), 1, { quantity: 1 }, ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      store.update(syntheticWidgets, 'not-an-id', 1, { quantity: 1 }, ctx),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await store.findById(syntheticWidgets, 'not-an-id')).toBeNull();
  });

  it('rolls back record and audit when the sync job cannot be written', async () => {
    const record = await store.create(syntheticWidgets, { name: 'Synthetic H', quantity: 1 }, ctx);
    // Pre-insert a job with the idempotency key the next update will use, forcing a duplicate key.
    await jobs().insertOne({
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
      store.update(syntheticWidgets, record._id, 1, { quantity: 9 }, ctx),
    ).rejects.toThrow(/duplicate key/);
    const stored = await widgets().findOne({ _id: record._id });
    expect(stored).toMatchObject({ quantity: 1, rev: 1 });
    expect(await audits().countDocuments({ 'entity.id': record._id, action: 'UPDATE' })).toBe(0);
  });

  it('stores provenance for imported records', async () => {
    const batchId = new ObjectId().toHexString();
    const record = await store.create(
      syntheticWidgets,
      { name: 'Synthetic I', quantity: 1 },
      {
        actor: { type: 'IMPORT', label: 'synthetic import' },
        provenance: {
          sourceType: 'HISTORICAL_IMPORT',
          importBatchId: batchId,
          workbook: 'Synthetic Workbook',
          sheet: 'Synthetic Sheet',
          rowNumber: 12,
          legacyRefs: [{ field: 'poNo', value: 'SYN/0001' }],
        },
      },
    );
    const stored = await widgets().findOne({ _id: record._id });
    expect(stored?.provenance).toMatchObject({ sourceType: 'HISTORICAL_IMPORT', rowNumber: 12 });
    const event = await audits().findOne({ 'entity.id': record._id });
    expect(event?.provenance).toMatchObject({ importBatchId: batchId });
  });
});
