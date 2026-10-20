import type { Express } from 'express';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/authService.js';
import { ensureAuthCollections } from '../../src/auth/collections.js';
import { UserAdmin } from '../../src/auth/userAdmin.js';
import {
  dashboardSummarySchema,
  demandDetailSchema,
  demandListResponseSchema,
} from '../../src/contracts/api.js';
import { COLLECTIONS, ensureInfrastructureCollections } from '../../src/db/collections.js';
import { connectToDatabase, type Database } from '../../src/db/mongo.js';
import { ensureDemandCollections } from '../../src/demands/definitions.js';
import { DemandService, todayInKarachi } from '../../src/demands/demandService.js';
import { createApp } from '../../src/http/app.js';
import { ensureMasterDataCollections } from '../../src/masterData/definitions.js';
import { MasterDataService } from '../../src/masterData/masterDataService.js';
import { RecordStore } from '../../src/records/recordStore.js';
import { capturingLogger, testConfig } from '../helpers.js';
import { startReplicaSet } from './memoryMongo.js';

// Synthetic accounts, master records and receiver details only.
const OPERATOR = { username: 'synthetic.operator', password: 'synthetic operator pass 1' };
const VIEWER = { username: 'synthetic.viewer', password: 'synthetic viewer pass 22' };
const SYNTHETIC_PHONE = '0000-0000001';

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

interface Refs {
  department: string;
  provinceA: string;
  provinceB: string;
  divisionA1: string;
  divisionA2: string;
  divisionB1: string;
  itemBox: string;
  itemBook: string;
}
let refs: Refs;

beforeAll(async () => {
  replSet = await startReplicaSet();
  const config = testConfig({
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB_NAME: 'pms_demand_test',
    RATE_LIMIT_MAX: '10000',
    // Every test signs in twice; the sign-in limiter itself is covered by auth.test.ts.
    LOGIN_RATE_LIMIT_MAX: '1000',
  });
  const captured = capturingLogger();
  logLines = captured.lines;
  database = await connectToDatabase(config.mongodb, captured.logger);
  const store = new RecordStore(database);
  app = createApp({
    config,
    logger: captured.logger,
    database,
    authService: new AuthService(database, config.auth),
    masterDataService: new MasterDataService(database, store),
    demandService: new DemandService(database, store),
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

function send(method: 'post' | 'patch', path: string, body: object, as: Session = operator) {
  const agent = request(app);
  return agent[method](`/api${path}`)
    .set('Cookie', as.cookie)
    .set('X-CSRF-Token', as.csrf)
    .send(body);
}

function get(path: string, as: Session = operator) {
  return request(app).get(`/api${path}`).set('Cookie', as.cookie);
}

async function master(entity: string, body: object): Promise<string> {
  const res = await send('post', `/master/${entity}`, body).expect(201);
  return res.body.id as string;
}

beforeEach(async () => {
  await database.db.dropDatabase();
  await ensureInfrastructureCollections(database.db);
  await ensureAuthCollections(database.db);
  await ensureMasterDataCollections(database.db);
  await ensureDemandCollections(database.db);
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

  const provinceA = await master('provinces', { name: 'Synthetic Province A' });
  const provinceB = await master('provinces', { name: 'Synthetic Province B' });
  refs = {
    department: await master('departments', { name: 'Synthetic Department' }),
    provinceA,
    provinceB,
    divisionA1: await master('divisions', { name: 'Synthetic A1', provinceId: provinceA }),
    divisionA2: await master('divisions', { name: 'Synthetic A2', provinceId: provinceA }),
    divisionB1: await master('divisions', { name: 'Synthetic B1', provinceId: provinceB }),
    itemBox: await master('items', { name: 'Synthetic Box' }),
    itemBook: await master('items', { name: 'Synthetic Book' }),
  };
});

function validDemand(overrides: object = {}) {
  return {
    demandDate: '2026-01-15',
    departmentId: refs.department,
    provinceId: refs.provinceA,
    sourceReference: 'Synthetic Province A Demand 1',
    lines: [
      {
        itemId: refs.itemBox,
        destinationDivisionId: refs.divisionA1,
        quantity: 500,
        receiverName: 'Synthetic Receiver',
        receiverPhone: SYNTHETIC_PHONE,
      },
      { itemId: refs.itemBook, destinationDivisionId: refs.divisionA2, quantity: 200 },
    ],
    ...overrides,
  };
}

async function createDemand(overrides: object = {}) {
  const res = await send('post', '/demands', validDemand(overrides));
  expect(res.status).toBe(201);
  return demandDetailSchema.parse(res.body);
}

describe('creating demands', () => {
  it('creates a demand with a unique Demand Number, lines and derived fulfilment', async () => {
    const demand = await createDemand();
    expect(demand.code).toBe('DMD-000001');
    expect(demand).toMatchObject({
      status: 'OPEN',
      fulfilment: 'PENDING',
      demandDate: '2026-01-15',
      lineCount: 2,
      totalQuantity: 700,
      rev: 1,
      sourceReference: 'Synthetic Province A Demand 1',
      department: { name: 'Synthetic Department', active: true },
      province: { name: 'Synthetic Province A' },
      division: null,
      personalDataVisible: true,
    });
    expect(demand.lines.map((l) => [l.lineNo, l.item.name, l.destinationDivision.name])).toEqual([
      [1, 'Synthetic Box', 'Synthetic A1'],
      [2, 'Synthetic Book', 'Synthetic A2'],
    ]);
    expect(demand.lines[0]).toMatchObject({
      quantity: 500,
      quantityDelivered: 0,
      quantityRemaining: 500,
      fulfilment: 'PENDING',
      receiverName: 'Synthetic Receiver',
      destinationDivision: { provinceName: 'Synthetic Province A' },
    });
    expect((await createDemand()).code).toBe('DMD-000002');
  });

  it('accepts an optional requesting division of the same province', async () => {
    const demand = await createDemand({ divisionId: refs.divisionA1 });
    expect(demand.division?.name).toBe('Synthetic A1');
    const wrong = await send('post', '/demands', validDemand({ divisionId: refs.divisionB1 }));
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details[0]).toMatchObject({
      path: 'divisionId',
      message: expect.stringMatching(/does not belong to province/),
    });
  });

  it('rejects missing and invalid fields with field paths', async () => {
    const res = await send('post', '/demands', {
      demandDate: '2026-02-30',
      departmentId: 'nope',
      lines: [],
      extra: true,
    });
    expect(res.status).toBe(400);
    const paths = res.body.error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(
      expect.arrayContaining(['demandDate', 'departmentId', 'provinceId', 'lines']),
    );

    const badLine = await send(
      'post',
      '/demands',
      validDemand({
        lines: [
          {
            itemId: refs.itemBox,
            destinationDivisionId: refs.divisionA1,
            quantity: 0,
            receiverPhone: 'call me',
          },
        ],
      }),
    );
    expect(badLine.status).toBe(400);
    expect(badLine.body.error.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['lines.0.quantity', 'lines.0.receiverPhone']),
    );
    expect(
      (await send('post', '/demands', validDemand({ lines: [{ quantity: 1.5 }] }))).status,
    ).toBe(400);
  });

  it('rejects future and implausibly old dates', async () => {
    const tomorrow = new Date(`${todayInKarachi()}T00:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const future = await send(
      'post',
      '/demands',
      validDemand({ demandDate: tomorrow.toISOString().slice(0, 10) }),
    );
    expect(future.status).toBe(400);
    expect(future.body.error.details[0].message).toBe('Date cannot be in the future');
    const old = await send('post', '/demands', validDemand({ demandDate: '1999-12-31' }));
    expect(old.status).toBe(400);
    await send('post', '/demands', validDemand({ demandDate: todayInKarachi() })).expect(201);
  });

  it('rejects duplicate lines for the same item and destination', async () => {
    const res = await send(
      'post',
      '/demands',
      validDemand({
        lines: [
          { itemId: refs.itemBox, destinationDivisionId: refs.divisionA1, quantity: 5 },
          { itemId: refs.itemBox, destinationDivisionId: refs.divisionA1, quantity: 7 },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details[0]).toMatchObject({
      path: 'lines.1',
      message: expect.stringMatching(/Duplicate line/),
    });
    // The same item for different destinations is fine.
    await send(
      'post',
      '/demands',
      validDemand({
        lines: [
          { itemId: refs.itemBox, destinationDivisionId: refs.divisionA1, quantity: 5 },
          { itemId: refs.itemBox, destinationDivisionId: refs.divisionA2, quantity: 7 },
        ],
      }),
    ).expect(201);
  });

  it('rejects unknown and inactive master-data references', async () => {
    const missing = await send(
      'post',
      '/demands',
      validDemand({ departmentId: '0123456789abcdef01234567' }),
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error.details[0]).toMatchObject({
      path: 'departmentId',
      message: 'Department not found',
    });

    await send('patch', `/master/items/${refs.itemBook}`, { rev: 1, active: false }).expect(200);
    const inactive = await send('post', '/demands', validDemand());
    expect(inactive.status).toBe(400);
    expect(inactive.body.error.details[0]).toMatchObject({
      path: 'lines.1.itemId',
      message: 'Item "Synthetic Book" is inactive',
    });
    expect(await database.db.collection('demands').countDocuments()).toBe(0);
  });
});

describe('editing and cancelling demands', () => {
  it('edits header and lines with revision checks and stable line identity', async () => {
    const demand = await createDemand();
    const [first, second] = demand.lines;
    if (!first || !second) throw new Error('lines missing');

    const res = await send('patch', `/demands/${demand.id}`, {
      rev: 1,
      sourceReference: 'Synthetic Province A Demand 1 (revised)',
      lines: [
        {
          id: first.id,
          itemId: refs.itemBox,
          destinationDivisionId: refs.divisionA1,
          quantity: 650,
        },
        { itemId: refs.itemBook, destinationDivisionId: refs.divisionA1, quantity: 10 },
      ],
    });
    expect(res.status).toBe(200);
    const updated = demandDetailSchema.parse(res.body);
    expect(updated.rev).toBe(2);
    expect(updated.code).toBe(demand.code);
    expect(updated.lines.map((l) => [l.id === first.id, l.lineNo, l.quantity])).toEqual([
      [true, 1, 650],
      [false, 3, 10], // line numbers are never reused
    ]);
    expect(updated.lines.some((l) => l.id === second.id)).toBe(false);

    const stale = await send('patch', `/demands/${demand.id}`, {
      rev: 1,
      demandDate: '2026-01-10',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('CONFLICT');
  });

  it('rejects lines that belong to another demand', async () => {
    const a = await createDemand();
    const b = await createDemand();
    const foreign = b.lines[0];
    if (!foreign) throw new Error('line missing');
    const res = await send('patch', `/demands/${a.id}`, {
      rev: 1,
      lines: [
        {
          id: foreign.id,
          itemId: refs.itemBox,
          destinationDivisionId: refs.divisionA1,
          quantity: 1,
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('lines.0.id');
  });

  it('keeps unchanged references to records deactivated later, but blocks new ones', async () => {
    const demand = await createDemand();
    await send('patch', `/master/items/${refs.itemBox}`, { rev: 1, active: false }).expect(200);

    const view = demandDetailSchema.parse((await get(`/demands/${demand.id}`)).body);
    expect(view.lines[0]?.item).toMatchObject({ name: 'Synthetic Box', active: false });

    const lines = demand.lines.map((l) => ({
      id: l.id,
      itemId: l.item.id,
      destinationDivisionId: l.destinationDivision.id,
      quantity: l.quantity + 1,
    }));
    await send('patch', `/demands/${demand.id}`, { rev: 1, lines }).expect(200);

    const addInactive = await send('patch', `/demands/${demand.id}`, {
      rev: 2,
      lines: [
        ...lines,
        { itemId: refs.itemBox, destinationDivisionId: refs.divisionA2, quantity: 1 },
      ],
    });
    expect(addInactive.status).toBe(400);
    expect(addInactive.body.error.details[0].message).toMatch(/inactive/);
  });

  it('cancels with a reason, keeps the record and blocks further edits', async () => {
    const demand = await createDemand();
    expect((await send('post', `/demands/${demand.id}/cancel`, { rev: 1 })).status).toBe(400);
    const res = await send('post', `/demands/${demand.id}/cancel`, {
      rev: 1,
      reason: 'Synthetic duplicate request',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'CANCELLED',
      rev: 2,
      cancellation: { reason: 'Synthetic duplicate request', by: OPERATOR.username },
    });
    const edit = await send('patch', `/demands/${demand.id}`, { rev: 2, demandDate: '2026-01-01' });
    expect(edit.status).toBe(409);
    expect(edit.body.error.message).toMatch(/cancelled/);
    const again = await send('post', `/demands/${demand.id}/cancel`, { rev: 2, reason: 'x' });
    expect(again.status).toBe(409);
    expect(await database.db.collection('demands').countDocuments()).toBe(1);
  });

  it('writes an audit trail and queues (unprocessed) sync jobs for the demand register', async () => {
    const demand = await createDemand();
    await send('patch', `/demands/${demand.id}`, { rev: 1, demandDate: '2026-01-10' }).expect(200);
    await send('post', `/demands/${demand.id}/cancel`, { rev: 2, reason: 'Synthetic test' }).expect(
      200,
    );
    const events = await database.db
      .collection(COLLECTIONS.auditEvents)
      .find({ 'entity.code': demand.code })
      .sort({ occurredAt: 1 })
      .toArray();
    expect(events.map((e) => e.action)).toEqual(['CREATE', 'UPDATE', 'ARCHIVE']);
    expect(events.every((e) => e.state === 'COMMITTED' && e.atomic === true)).toBe(true);
    expect(events[1]?.actor).toMatchObject({ type: 'USER', label: OPERATOR.username });
    expect(events[1]?.changes).toEqual([
      { field: 'demandDate', before: '2026-01-15', after: '2026-01-10' },
    ]);
    const jobs = await database.db
      .collection(COLLECTIONS.syncJobs)
      .find({ 'entity.code': demand.code })
      .toArray();
    expect(jobs).toHaveLength(3);
    expect(jobs.every((j) => j.status === 'PENDING' && j.target.workbook === 'DMD')).toBe(true);
  });
});

describe('listing, searching and filtering demands', () => {
  beforeEach(async () => {
    await createDemand({ demandDate: '2026-01-05', sourceReference: 'Synthetic Alpha request' });
    await createDemand({ demandDate: '2026-02-05', sourceReference: 'Synthetic Beta request' });
    await createDemand({
      demandDate: '2026-03-05',
      provinceId: refs.provinceB,
      sourceReference: 'Synthetic Gamma request',
      lines: [{ itemId: refs.itemBox, destinationDivisionId: refs.divisionB1, quantity: 3 }],
    });
  });

  it('lists newest first with pagination and totals', async () => {
    const res = await get('/demands?pageSize=2');
    const body = demandListResponseSchema.parse(res.body);
    expect(body.total).toBe(3);
    expect(body.items.map((d) => d.demandDate)).toEqual(['2026-03-05', '2026-02-05']);
    const second = demandListResponseSchema.parse((await get('/demands?pageSize=2&page=2')).body);
    expect(second.items.map((d) => d.code)).toEqual(['DMD-000001']);
    const oldest = demandListResponseSchema.parse((await get('/demands?sort=demandDate_asc')).body);
    expect(oldest.items[0]?.demandDate).toBe('2026-01-05');
  });

  it('searches the Demand Number and source reference literally', async () => {
    expect(
      (await get('/demands?search=beta')).body.items.map((d: { code: string }) => d.code),
    ).toEqual(['DMD-000002']);
    expect((await get('/demands?search=dmd-000003')).body.total).toBe(1);
    expect((await get('/demands?search=.*')).body.total).toBe(0);
  });

  it('filters by province, department, date range and status', async () => {
    expect((await get(`/demands?provinceId=${refs.provinceB}`)).body.total).toBe(1);
    expect((await get(`/demands?departmentId=${refs.department}`)).body.total).toBe(3);
    expect((await get('/demands?from=2026-02-01&to=2026-02-28')).body.total).toBe(1);
    expect((await get('/demands?from=2026-03-01&to=2026-02-01')).status).toBe(400);

    const list = (await get('/demands?search=alpha')).body;
    await send('post', `/demands/${list.items[0].id}/cancel`, { rev: 1, reason: 'Synthetic' });
    expect((await get('/demands')).body.total).toBe(2);
    expect((await get('/demands?status=cancelled')).body.total).toBe(1);
    expect((await get('/demands?status=all')).body.total).toBe(3);
  });

  it('validates list parameters', async () => {
    for (const q of [
      '?pageSize=500',
      '?status=closed',
      '?sort=amount',
      '?from=2026-13-01',
      '?x=1',
    ]) {
      expect((await get(`/demands${q}`)).status, q).toBe(400);
    }
  });

  it('counts open demand lines on the dashboard from real data', async () => {
    const summary = dashboardSummarySchema.parse((await get('/dashboard/summary')).body);
    const open = summary.indicators.find((i) => i.key === 'openDemands');
    expect(open).toMatchObject({ status: 'available', value: 5, plannedMilestone: null });
    // Modules that do not exist yet stay unavailable.
    expect(
      summary.indicators.filter((i) => i.key !== 'openDemands').every((i) => i.value === null),
    ).toBe(true);
  });
});

describe('permissions and personal data', () => {
  it('requires a session and the CSRF token', async () => {
    expect((await request(app).get('/api/demands')).status).toBe(401);
    const noCsrf = await request(app)
      .post('/api/demands')
      .set('Cookie', operator.cookie)
      .send(validDemand());
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED');
  });

  it('lets read-only users read but never create, edit or cancel', async () => {
    const demand = await createDemand();
    expect((await get('/demands', viewer)).body.total).toBe(1);
    expect((await send('post', '/demands', validDemand(), viewer)).status).toBe(403);
    expect(
      (await send('patch', `/demands/${demand.id}`, { rev: 1, demandDate: '2026-01-01' }, viewer))
        .status,
    ).toBe(403);
    expect(
      (await send('post', `/demands/${demand.id}/cancel`, { rev: 1, reason: 'x' }, viewer)).status,
    ).toBe(403);
    expect((await get(`/demands/${demand.id}`)).body.rev).toBe(1);
  });

  it('hides receiver names and phones from read-only users (Q-30)', async () => {
    const demand = await createDemand();
    const asViewer = await get(`/demands/${demand.id}`, viewer);
    expect(asViewer.body.personalDataVisible).toBe(false);
    expect(JSON.stringify(asViewer.body)).not.toContain('Synthetic Receiver');
    expect(JSON.stringify(asViewer.body)).not.toContain(SYNTHETIC_PHONE);
    const list = JSON.stringify((await get('/demands', viewer)).body);
    expect(list).not.toContain(SYNTHETIC_PHONE);
    const asOperator = await get(`/demands/${demand.id}`);
    expect(asOperator.body.lines[0].receiverPhone).toBe(SYNTHETIC_PHONE);
  });

  it('keeps personal data and credentials out of request logs', async () => {
    await createDemand();
    const logs = logLines.join('\n');
    expect(logs).not.toContain(SYNTHETIC_PHONE);
    expect(logs).not.toContain('Synthetic Receiver');
    expect(logs).not.toContain(OPERATOR.password);
  });
});
