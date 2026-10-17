import type { Express } from 'express';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/authService.js';
import { ensureAuthCollections } from '../../src/auth/collections.js';
import { UserAdmin } from '../../src/auth/userAdmin.js';
import { masterListResponseSchema, masterRecordSchema } from '../../src/contracts/api.js';
import { COLLECTIONS, ensureInfrastructureCollections } from '../../src/db/collections.js';
import { connectToDatabase, type Database } from '../../src/db/mongo.js';
import { createApp } from '../../src/http/app.js';
import { ensureMasterDataCollections } from '../../src/masterData/definitions.js';
import { MasterDataService } from '../../src/masterData/masterDataService.js';
import { RecordStore } from '../../src/records/recordStore.js';
import { capturingLogger, testConfig } from '../helpers.js';
import { startReplicaSet } from './memoryMongo.js';

// Synthetic accounts and synthetic master-data names only ("Synthetic …").
const OPERATOR = { username: 'synthetic.operator', password: 'synthetic operator pass 1' };
const VIEWER = { username: 'synthetic.viewer', password: 'synthetic viewer pass 22' };

let replSet: MongoMemoryReplSet;
let database: Database;
let app: Express;
let logLines: string[];

interface Session {
  cookie: string;
  csrf: string;
}
let operator: Session;
let viewer: Session;

beforeAll(async () => {
  replSet = await startReplicaSet();
  const config = testConfig({
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB_NAME: 'pms_master_test',
    RATE_LIMIT_MAX: '10000',
    // Every test signs in twice; the sign-in limiter itself is covered by auth.test.ts.
    LOGIN_RATE_LIMIT_MAX: '1000',
  });
  const captured = capturingLogger();
  logLines = captured.lines;
  database = await connectToDatabase(config.mongodb, captured.logger);
  const store = new RecordStore(database);
  const authService = new AuthService(database, config.auth);
  app = createApp({
    config,
    logger: captured.logger,
    database,
    authService,
    masterDataService: new MasterDataService(database, store),
  });
});

afterAll(async () => {
  await database?.close();
  await replSet?.stop();
});

async function signIn(account: { username: string; password: string }): Promise<Session> {
  const res = await request(app).post('/api/auth/login').send(account).expect(200);
  const cookie = (res.headers['set-cookie'] as unknown as string[])[0]?.split(';')[0] as string;
  return { cookie, csrf: res.body.csrfToken as string };
}

beforeEach(async () => {
  await database.db.dropDatabase();
  await ensureInfrastructureCollections(database.db);
  await ensureAuthCollections(database.db);
  await ensureMasterDataCollections(database.db);
  const admin = new UserAdmin(
    database.db,
    new RecordStore(database),
    { type: 'SYSTEM', label: 'test' },
    async () => 0,
  );
  await admin.create({ ...OPERATOR, displayName: 'Synthetic Operator', role: 'OPERATOR' });
  await admin.create({ ...VIEWER, displayName: 'Synthetic Viewer', role: 'VIEWER' });
  operator = await signIn(OPERATOR);
  viewer = await signIn(VIEWER);
});

function create(entity: string, body: object, as: Session = operator) {
  return request(app)
    .post(`/api/master/${entity}`)
    .set('Cookie', as.cookie)
    .set('X-CSRF-Token', as.csrf)
    .send(body);
}

function update(entity: string, id: string, body: object, as: Session = operator) {
  return request(app)
    .patch(`/api/master/${entity}/${id}`)
    .set('Cookie', as.cookie)
    .set('X-CSRF-Token', as.csrf)
    .send(body);
}

function list(entity: string, query = '', as: Session = operator) {
  return request(app).get(`/api/master/${entity}${query}`).set('Cookie', as.cookie);
}

describe('master data — create and read', () => {
  it.each(['departments', 'items', 'vendors', 'warehouses', 'provinces'])(
    'creates and reads %s with a permanent code',
    async (entity) => {
      const res = await create(entity, { name: '  Synthetic   Record  ' });
      expect(res.status).toBe(201);
      const record = masterRecordSchema.parse(res.body);
      expect(record).toMatchObject({ name: 'Synthetic Record', active: true, rev: 1 });
      expect(record.code).toMatch(/^[A-Z]{3}-\d{6}$/);
      const read = await request(app)
        .get(`/api/master/${entity}/${record.id}`)
        .set('Cookie', viewer.cookie);
      expect(read.status).toBe(200);
      expect(read.body.code).toBe(record.code);
      expect(read.body).not.toHaveProperty('nameKey');
    },
  );

  it('creates divisions under an active province and returns the province name', async () => {
    const province = (await create('provinces', { name: 'Synthetic Province' })).body;
    const res = await create('divisions', { name: 'Synthetic Division', provinceId: province.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      provinceId: province.id,
      provinceName: 'Synthetic Province',
    });
  });

  it('returns 404 for unknown lists and records', async () => {
    expect((await list('bilties')).status).toBe(404);
    expect((await list('items/0123456789abcdef01234567')).status).toBe(404);
    expect((await list('items/not-an-id')).status).toBe(404);
  });
});

describe('master data — validation and references', () => {
  it('rejects missing, blank, too long and unknown fields', async () => {
    for (const body of [
      {},
      { name: '   ' },
      { name: 'x'.repeat(101) },
      { name: 'Ok', code: 'X' },
    ]) {
      const res = await create('items', body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
    const control = await create('items', { name: 'Synthetic\u0007Bell' });
    expect(control.status).toBe(400);
  });

  it('requires a valid, existing and active province for divisions', async () => {
    expect((await create('divisions', { name: 'Synthetic Division' })).status).toBe(400);
    const missing = await create('divisions', {
      name: 'Synthetic Division',
      provinceId: '0123456789abcdef01234567',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0].message).toBe('Province not found');

    const province = (await create('provinces', { name: 'Synthetic Province' })).body;
    await update('provinces', province.id, { rev: 1, active: false }).expect(200);
    const inactive = await create('divisions', {
      name: 'Synthetic Division',
      provinceId: province.id,
    });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error.details[0].message).toMatch(/inactive/);
  });

  it('rejects a province reference on entities that have no parent', async () => {
    const province = (await create('provinces', { name: 'Synthetic Province' })).body;
    const res = await create('items', { name: 'Synthetic Item', provinceId: province.id });
    expect(res.status).toBe(400);
  });
});

describe('master data — duplicates', () => {
  it('prevents duplicate names ignoring case and spacing', async () => {
    await create('vendors', { name: 'Synthetic Vendor Co' }).expect(201);
    const dup = await create('vendors', { name: '  synthetic   VENDOR co ' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('CONFLICT');
    // The same name is fine in a different entity.
    await create('items', { name: 'Synthetic Vendor Co' }).expect(201);
  });

  it('allows the same division name in different provinces, not in the same one', async () => {
    const a = (await create('provinces', { name: 'Synthetic Province A' })).body;
    const b = (await create('provinces', { name: 'Synthetic Province B' })).body;
    await create('divisions', { name: 'Synthetic Central', provinceId: a.id }).expect(201);
    await create('divisions', { name: 'Synthetic Central', provinceId: b.id }).expect(201);
    const dup = await create('divisions', { name: 'synthetic central', provinceId: a.id });
    expect(dup.status).toBe(409);
  });

  it('prevents renaming onto an existing name', async () => {
    await create('items', { name: 'Synthetic Box' }).expect(201);
    const other = (await create('items', { name: 'Synthetic Book' })).body;
    const res = await update('items', other.id, { rev: 1, name: 'SYNTHETIC BOX' });
    expect(res.status).toBe(409);
  });

  it('enforces uniqueness in the database even under concurrent creates', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => create('warehouses', { name: 'Synthetic Store' })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });
});

describe('master data — update, deactivation and history', () => {
  it('updates with optimistic concurrency and audits the change', async () => {
    const item = (await create('items', { name: 'Synthetic Old Name' })).body;
    const res = await update('items', item.id, { rev: 1, name: 'Synthetic New Name' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Synthetic New Name', rev: 2, code: item.code });

    const stale = await update('items', item.id, { rev: 1, name: 'Synthetic Other' });
    expect(stale.status).toBe(409);

    const events = await database.db
      .collection(COLLECTIONS.auditEvents)
      .find({ 'entity.code': item.code })
      .sort({ occurredAt: 1 })
      .toArray();
    expect(events.map((e) => e.action)).toEqual(['CREATE', 'UPDATE']);
    expect(events[1]?.actor).toMatchObject({ type: 'USER', label: OPERATOR.username });
    expect(events[1]?.changes).toEqual(
      expect.arrayContaining([
        { field: 'name', before: 'Synthetic Old Name', after: 'Synthetic New Name' },
      ]),
    );
  });

  it('deactivates and reactivates without deleting', async () => {
    const vendor = (await create('vendors', { name: 'Synthetic Supplier' })).body;
    const off = await update('vendors', vendor.id, { rev: 1, active: false });
    expect(off.body).toMatchObject({ active: false, rev: 2 });
    expect((await list('vendors')).body.total).toBe(0);
    expect((await list('vendors', '?status=inactive')).body.total).toBe(1);
    const on = await update('vendors', vendor.id, { rev: 2, active: true });
    expect(on.body).toMatchObject({ active: true, rev: 3 });
    expect(await database.db.collection('vendors').countDocuments()).toBe(1);
  });

  it('blocks deactivating a province that still has active divisions', async () => {
    const province = (await create('provinces', { name: 'Synthetic Province' })).body;
    const division = (
      await create('divisions', { name: 'Synthetic Division', provinceId: province.id })
    ).body;
    const blocked = await update('provinces', province.id, { rev: 1, active: false });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/1 active division/);

    await update('divisions', division.id, { rev: 1, active: false }).expect(200);
    await update('provinces', province.id, { rev: 1, active: false }).expect(200);
    // The inactive division keeps its province reference.
    const read = await list(`divisions/${division.id}`);
    expect(read.body).toMatchObject({
      provinceId: province.id,
      provinceName: 'Synthetic Province',
    });
    // It cannot be reactivated while its province is inactive.
    const reactivate = await update('divisions', division.id, { rev: 2, active: true });
    expect(reactivate.status).toBe(400);
  });

  it('moves a division to another active province', async () => {
    const a = (await create('provinces', { name: 'Synthetic Province A' })).body;
    const b = (await create('provinces', { name: 'Synthetic Province B' })).body;
    const division = (await create('divisions', { name: 'Synthetic Division', provinceId: a.id }))
      .body;
    const moved = await update('divisions', division.id, { rev: 1, provinceId: b.id });
    expect(moved.body).toMatchObject({ provinceId: b.id, provinceName: 'Synthetic Province B' });
  });

  it('rejects updates with nothing to change', async () => {
    const item = (await create('items', { name: 'Synthetic Item' })).body;
    expect((await update('items', item.id, { rev: 1 })).status).toBe(400);
    expect((await update('items', item.id, {})).status).toBe(400);
  });
});

describe('master data — search, filters and pagination', () => {
  beforeEach(async () => {
    for (const name of ['Synthetic Alpha', 'Synthetic Beta', 'Synthetic Gamma', 'Other Delta']) {
      await create('items', { name }).expect(201);
    }
  });

  it('searches by name, case-insensitively, and treats input literally', async () => {
    const res = await list('items', '?search=SYNTHETIC');
    const body = masterListResponseSchema.parse(res.body);
    expect(body.total).toBe(3);
    expect(body.items.map((i) => i.name)).toEqual([
      'Synthetic Alpha',
      'Synthetic Beta',
      'Synthetic Gamma',
    ]);
    expect((await list('items', '?search=.*')).body.total).toBe(0);
  });

  it('paginates in name order', async () => {
    const first = (await list('items', '?pageSize=2&page=1')).body;
    const second = (await list('items', '?pageSize=2&page=2')).body;
    expect(first).toMatchObject({ total: 4, page: 1, pageSize: 2 });
    expect(first.items.map((i: { name: string }) => i.name)).toEqual([
      'Other Delta',
      'Synthetic Alpha',
    ]);
    expect(second.items.map((i: { name: string }) => i.name)).toEqual([
      'Synthetic Beta',
      'Synthetic Gamma',
    ]);
  });

  it('validates list parameters', async () => {
    expect((await list('items', '?pageSize=500')).status).toBe(400);
    expect((await list('items', '?status=deleted')).status).toBe(400);
    expect((await list('items', '?unknown=1')).status).toBe(400);
    expect((await list('items', '?provinceId=0123456789abcdef01234567')).status).toBe(400);
  });

  it('filters divisions by province', async () => {
    const a = (await create('provinces', { name: 'Synthetic Province A' })).body;
    const b = (await create('provinces', { name: 'Synthetic Province B' })).body;
    await create('divisions', { name: 'Synthetic North', provinceId: a.id }).expect(201);
    await create('divisions', { name: 'Synthetic South', provinceId: b.id }).expect(201);
    const res = await list('divisions', `?provinceId=${a.id}`);
    expect(res.body.items.map((d: { name: string }) => d.name)).toEqual(['Synthetic North']);
  });
});

describe('master data — authentication and roles', () => {
  it('requires a session for reads and writes', async () => {
    expect((await request(app).get('/api/master/items')).status).toBe(401);
    expect((await request(app).post('/api/master/items').send({ name: 'X' })).status).toBe(401);
  });

  it('lets read-only users read but never write', async () => {
    const item = (await create('items', { name: 'Synthetic Item' })).body;
    expect((await list('items', '', viewer)).status).toBe(200);

    const created = await create('items', { name: 'Synthetic Viewer Item' }, viewer);
    expect(created.status).toBe(403);
    expect(created.body.error.code).toBe('FORBIDDEN');
    const changed = await update('items', item.id, { rev: 1, active: false }, viewer);
    expect(changed.status).toBe(403);
    expect(await database.db.collection('items').countDocuments()).toBe(1);
    expect((await list(`items/${item.id}`)).body).toMatchObject({ active: true, rev: 1 });
  });

  it('requires the CSRF token for writes', async () => {
    const res = await request(app)
      .post('/api/master/items')
      .set('Cookie', operator.cookie)
      .send({ name: 'Synthetic Item' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_FAILED');
  });

  it('never returns sensitive or internal fields', async () => {
    await create('items', { name: 'Synthetic Item' });
    const body = JSON.stringify((await list('items')).body);
    expect(body).not.toMatch(/passwordHash|scrypt|csrf|nameKey|lifecycle|createdBy/i);
    expect(logLines.join('\n')).not.toContain(OPERATOR.password);
  });
});
