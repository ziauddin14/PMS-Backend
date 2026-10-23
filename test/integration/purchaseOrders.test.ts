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
  purchaseOrderDetailSchema,
  purchaseOrderListResponseSchema,
} from '../../src/contracts/api.js';
import { COLLECTIONS, ensureInfrastructureCollections } from '../../src/db/collections.js';
import { connectToDatabase, type Database } from '../../src/db/mongo.js';
import { ensureDemandCollections } from '../../src/demands/definitions.js';
import { DemandService } from '../../src/demands/demandService.js';
import { ensurePurchaseOrderCollections } from '../../src/purchaseOrders/definitions.js';
import { PurchaseOrderService } from '../../src/purchaseOrders/purchaseOrderService.js';
import { createApp } from '../../src/http/app.js';
import { ensureMasterDataCollections } from '../../src/masterData/definitions.js';
import { MasterDataService } from '../../src/masterData/masterDataService.js';
import { RecordStore } from '../../src/records/recordStore.js';
import { capturingLogger, testConfig } from '../helpers.js';
import { startReplicaSet } from './memoryMongo.js';

const OPERATOR = { username: 'synthetic.operator', password: 'synthetic operator pass 1' };
const VIEWER = { username: 'synthetic.viewer', password: 'synthetic viewer pass 22' };

let replSet: MongoMemoryReplSet;
let database: Database;
let app: Express;

interface Session {
  cookie: string;
  csrf: string;
}
let operator: Session;
let viewer: Session;

interface Refs {
  vendorA: string;
  vendorB: string;
  warehouseFem: string;
  warehouseNay: string;
  provinceA: string;
  divisionA1: string;
  itemBox: string;
  itemBook: string;
  demandId: string;
  demandLineId: string;
}
let refs: Refs;

beforeAll(async () => {
  replSet = await startReplicaSet();
  const config = testConfig({
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB_NAME: 'pms_purchase_order_test',
    RATE_LIMIT_MAX: '10000',
    LOGIN_RATE_LIMIT_MAX: '1000',
  });
  const captured = capturingLogger();
  database = await connectToDatabase(config.mongodb, captured.logger);
  const store = new RecordStore(database);
  const demandService = new DemandService(database, store);
  const purchaseOrderService = new PurchaseOrderService(database, store);
  app = createApp({
    config,
    logger: captured.logger,
    database,
    authService: new AuthService(database, config.auth),
    masterDataService: new MasterDataService(database, store),
    demandService,
    purchaseOrderService,
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
  await ensurePurchaseOrderCollections(database.db);

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
  const divisionA1 = await master('divisions', {
    name: 'Synthetic Division A1',
    provinceId: provinceA,
  });
  const department = await master('departments', { name: 'Synthetic Department' });
  const itemBox = await master('items', { name: 'Synthetic Box' });
  const itemBook = await master('items', { name: 'Synthetic Book' });
  const vendorA = await master('vendors', { name: 'Synthetic Vendor A' });
  const vendorB = await master('vendors', { name: 'Synthetic Vendor B' });
  const warehouseFem = await master('warehouses', { name: 'Synthetic FEM Warehouse' });
  const warehouseNay = await master('warehouses', { name: 'Synthetic Nayabad Warehouse' });

  // Create a seed demand to test PO-to-demand links
  const dRes = await send('post', '/demands', {
    demandDate: '2026-01-10',
    departmentId: department,
    provinceId: provinceA,
    sourceReference: 'Synthetic Demand for PO link',
    lines: [{ itemId: itemBox, destinationDivisionId: divisionA1, quantity: 1000 }],
  }).expect(201);
  const parsedDemand = demandDetailSchema.parse(dRes.body);

  refs = {
    vendorA,
    vendorB,
    warehouseFem,
    warehouseNay,
    provinceA,
    divisionA1,
    itemBox,
    itemBook,
    demandId: parsedDemand.id,
    demandLineId: parsedDemand.lines[0]!.id,
  };
});

function validPurchaseOrder(overrides: object = {}) {
  return {
    poNumber: 'DIT/0189',
    poDate: '2026-01-15',
    vendorId: refs.vendorA,
    deliveryRoute: 'WAREHOUSE' as const,
    targetWarehouseId: refs.warehouseFem,
    approvedAmount: 50000,
    expectedCompletionDate: '2026-02-15',
    notes: 'Initial synthetic order',
    paymentSchedule: [
      { entryNo: 1, dueDate: '2026-01-20', plannedAmount: 25000, note: '50% advance' },
      { entryNo: 2, dueDate: '2026-02-20', plannedAmount: 25000, note: 'Balance on delivery' },
    ],
    invoice: {
      invoiceNo: 'INV-2026-001',
      invoiceDate: '2026-01-15',
      invoiceAmount: 50000,
      notes: 'Vendor invoice for complete PO',
    },
    lines: [
      {
        itemId: refs.itemBox,
        demandId: refs.demandId,
        demandLineId: refs.demandLineId,
        quantityOrdered: 500,
        unitPrice: 70,
        notes: 'Boxes for Demand 1',
      },
      {
        itemId: refs.itemBook,
        quantityOrdered: 100,
        unitPrice: 150,
        notes: 'Buffer stock books',
      },
    ],
    ...overrides,
  };
}

async function createPurchaseOrder(overrides: object = {}) {
  const res = await send('post', '/purchase-orders', validPurchaseOrder(overrides));
  expect(res.status).toBe(201);
  return purchaseOrderDetailSchema.parse(res.body);
}

describe('creating purchase orders', () => {
  it('creates a PO with unique code, lines, total amount, and PENDING completion', async () => {
    const po = await createPurchaseOrder();
    expect(po.code).toMatch(/^PO-[0-9]{6}$/);
    expect(po.poNumber).toBe('DIT/0189');
    expect(po.status).toBe('OPEN');
    expect(po.completion).toBe('PENDING');
    expect(po.deliveryRoute).toBe('WAREHOUSE');
    expect(po.targetWarehouse?.name).toBe('Synthetic FEM Warehouse');
    expect(po.destinationDivision).toBeNull();
    expect(po.approvedAmount).toBe(50000);
    expect(po.totalAmount).toBe(500 * 70 + 100 * 150); // 35000 + 15000 = 50000
    expect(po.lineCount).toBe(2);
    expect(po.totalQuantity).toBe(600);
    expect(po.lines[0]!.lineNo).toBe(1);
    expect(po.lines[0]!.quantityOrdered).toBe(500);
    expect(po.lines[0]!.quantityReceived).toBe(0);
    expect(po.lines[0]!.quantityRemaining).toBe(500);
    expect(po.lines[0]!.completion).toBe('PENDING');
    expect(po.lines[0]!.demand?.id).toBe(refs.demandId);
    expect(po.paymentSchedule).toHaveLength(2);
    expect(po.invoice?.invoiceNo).toBe('INV-2026-001');
  });

  it('accepts direct delivery route with destination division', async () => {
    const po = await createPurchaseOrder({
      poNumber: 'DIR/001',
      deliveryRoute: 'DIRECT',
      targetWarehouseId: null,
      destinationDivisionId: refs.divisionA1,
    });
    expect(po.deliveryRoute).toBe('DIRECT');
    expect(po.targetWarehouse).toBeNull();
    expect(po.destinationDivision?.name).toBe('Synthetic Division A1');
  });

  it('rejects duplicate PO number ignoring case and spacing', async () => {
    await createPurchaseOrder({ poNumber: 'DIT/0189' });
    const res = await send(
      'post',
      '/purchase-orders',
      validPurchaseOrder({ poNumber: '  dit/0189  ' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('poNumber');
  });

  it('rejects duplicate PO number on edit', async () => {
    await createPurchaseOrder({ poNumber: 'PO-ALPHA' });
    const po2 = await createPurchaseOrder({ poNumber: 'PO-BETA' });
    const res = await send('patch', `/purchase-orders/${po2.id}`, {
      rev: po2.rev,
      poNumber: '  po-alpha  ',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe('poNumber');
  });

  it('enforces PO number uniqueness under concurrent creates', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        send('post', '/purchase-orders', validPurchaseOrder({ poNumber: 'CONCURRENT/001' })),
      ),
    );
    const created = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 400);
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect(r.body.error.details[0].path).toBe('poNumber');
    }
  });

  it('rejects missing route targets', async () => {
    const whRes = await send(
      'post',
      '/purchase-orders',
      validPurchaseOrder({ deliveryRoute: 'WAREHOUSE', targetWarehouseId: null }),
    );
    expect(whRes.status).toBe(400);
    expect(whRes.body.error.details[0].path).toBe('targetWarehouseId');

    const dirRes = await send(
      'post',
      '/purchase-orders',
      validPurchaseOrder({ deliveryRoute: 'DIRECT', destinationDivisionId: null }),
    );
    expect(dirRes.status).toBe(400);
    expect(dirRes.body.error.details[0].path).toBe('destinationDivisionId');
  });

  it('rejects duplicate item and demandLine pairs within one PO', async () => {
    const res = await send(
      'post',
      '/purchase-orders',
      validPurchaseOrder({
        lines: [
          { itemId: refs.itemBox, quantityOrdered: 100, unitPrice: 50 },
          { itemId: refs.itemBox, quantityOrdered: 200, unitPrice: 50 },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toContain('Combine the quantities instead');
  });

  it('rejects mismatched item when linked to a demand line', async () => {
    const res = await send(
      'post',
      '/purchase-orders',
      validPurchaseOrder({
        lines: [
          {
            itemId: refs.itemBook, // demand line requested itemBox, not itemBook
            demandId: refs.demandId,
            demandLineId: refs.demandLineId,
            quantityOrdered: 50,
            unitPrice: 100,
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toContain('does not match the item requested');
  });

  it('rejects inactive vendor reference on create', async () => {
    await send('patch', `/master/vendors/${refs.vendorB}`, { rev: 1, active: false }).expect(200);
    const res = await send(
      'post',
      '/purchase-orders',
      validPurchaseOrder({ vendorId: refs.vendorB }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].message).toContain('is inactive');
  });
});

describe('editing and cancelling purchase orders', () => {
  it('edits PO header, lines, schedule and invoice with revision check', async () => {
    const po = await createPurchaseOrder();
    const lineId0 = po.lines[0]!.id;
    const res = await send('patch', `/purchase-orders/${po.id}`, {
      rev: po.rev,
      poNumber: 'DIT/0189-REV',
      approvedAmount: 60000,
      lines: [
        {
          id: lineId0,
          itemId: refs.itemBox,
          quantityOrdered: 600,
          unitPrice: 75,
        },
      ],
      paymentSchedule: [{ entryNo: 1, dueDate: '2026-03-01', plannedAmount: 45000 }],
    });
    expect(res.status).toBe(200);
    const updated = purchaseOrderDetailSchema.parse(res.body);
    expect(updated.rev).toBe(po.rev + 1);
    expect(updated.poNumber).toBe('DIT/0189-REV');
    expect(updated.approvedAmount).toBe(60000);
    expect(updated.totalAmount).toBe(600 * 75); // 45000
    expect(updated.lines).toHaveLength(1);
    expect(updated.lines[0]!.id).toBe(lineId0);
    expect(updated.lines[0]!.lineNo).toBe(1);
    expect(updated.lines[0]!.quantityOrdered).toBe(600);
    expect(updated.paymentSchedule).toHaveLength(1);
  });

  it('rejects stale revision on edit', async () => {
    const po = await createPurchaseOrder();
    await send('patch', `/purchase-orders/${po.id}`, {
      rev: po.rev,
      notes: 'First update',
    }).expect(200);

    const staleRes = await send('patch', `/purchase-orders/${po.id}`, {
      rev: po.rev, // stale rev
      notes: 'Stale update',
    });
    expect(staleRes.status).toBe(409);
  });

  it('keeps unchanged references to deactivated records, but blocks new ones', async () => {
    const po = await createPurchaseOrder();
    // Deactivate vendor A
    await send('patch', `/master/vendors/${refs.vendorA}`, { rev: 1, active: false }).expect(200);

    // Editing other fields while vendor A is unchanged succeeds
    const editRes = await send('patch', `/purchase-orders/${po.id}`, {
      rev: po.rev,
      notes: 'Updated with inactive historical vendor',
    });
    expect(editRes.status).toBe(200);
    expect(editRes.body.vendor.active).toBe(false);

    // But changing to vendor B after deactivating vendor B fails
    await send('patch', `/master/vendors/${refs.vendorB}`, { rev: 1, active: false }).expect(200);
    const badRes = await send('patch', `/purchase-orders/${po.id}`, {
      rev: editRes.body.rev,
      vendorId: refs.vendorB,
    });
    expect(badRes.status).toBe(400);
    expect(badRes.body.error.details[0].message).toContain('is inactive');
  });

  it('cancels with a reason, archives record, and blocks further edits', async () => {
    const po = await createPurchaseOrder();
    const cancelRes = await send('post', `/purchase-orders/${po.id}/cancel`, {
      rev: po.rev,
      reason: 'Synthetic cancellation reason: supplier unable to deliver',
    });
    expect(cancelRes.status).toBe(200);
    const cancelled = purchaseOrderDetailSchema.parse(cancelRes.body);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancellation?.reason).toBe(
      'Synthetic cancellation reason: supplier unable to deliver',
    );
    expect(cancelled.cancellation?.by).toBe('synthetic.operator');

    // Attempting to edit cancelled PO returns 409
    const editRes = await send('patch', `/purchase-orders/${po.id}`, {
      rev: cancelled.rev,
      notes: 'Trying to edit cancelled PO',
    });
    expect(editRes.status).toBe(409);

    // Attempting to cancel twice returns 409
    const cancelTwice = await send('post', `/purchase-orders/${po.id}/cancel`, {
      rev: cancelled.rev,
      reason: 'Cancelling again',
    });
    expect(cancelTwice.status).toBe(409);
  });

  it('writes audit events and queues sync jobs for PRD PO', async () => {
    const po = await createPurchaseOrder();
    const auditEvents = await database.db
      .collection(COLLECTIONS.auditEvents)
      .find({ 'entity.code': po.code })
      .toArray();
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]!.action).toBe('CREATE');
    expect(auditEvents[0]!.actor.label).toBe('synthetic.operator');

    const syncJobs = await database.db
      .collection(COLLECTIONS.syncJobs)
      .find({ 'entity.code': po.code })
      .toArray();
    expect(syncJobs).toHaveLength(1);
    expect(syncJobs[0]!.target.workbook).toBe('PRD');
    expect(syncJobs[0]!.target.sheet).toBe('PO');
    expect(syncJobs[0]!.status).toBe('PENDING');
  });
});

describe('listing, searching, filtering and dashboard integration', () => {
  it('lists newest first with pagination and totals', async () => {
    await createPurchaseOrder({ poNumber: 'PO-A', poDate: '2026-01-05' });
    await createPurchaseOrder({ poNumber: 'PO-B', poDate: '2026-01-10' });
    await createPurchaseOrder({ poNumber: 'PO-C', poDate: '2026-01-15' });

    const res = await get('/purchase-orders?page=1&pageSize=2');
    expect(res.status).toBe(200);
    const list = purchaseOrderListResponseSchema.parse(res.body);
    expect(list.total).toBe(3);
    expect(list.items).toHaveLength(2);
    expect(list.items[0]!.poNumber).toBe('PO-C');
    expect(list.items[1]!.poNumber).toBe('PO-B');
  });

  it('searches literally by PO number, code and notes', async () => {
    await createPurchaseOrder({ poNumber: 'DIT/0189', notes: 'Special khususi batch' });
    await createPurchaseOrder({ poNumber: 'BE/DI/022', notes: 'Standard donation boxes' });

    const resNumber = await get('/purchase-orders?search=DIT/0189');
    expect(resNumber.body.items).toHaveLength(1);
    expect(resNumber.body.items[0].poNumber).toBe('DIT/0189');

    const resNote = await get('/purchase-orders?search=khususi');
    expect(resNote.body.items).toHaveLength(1);
    expect(resNote.body.items[0].poNumber).toBe('DIT/0189');
  });

  it('filters by vendor, route, status and date range', async () => {
    const po1 = await createPurchaseOrder({
      poNumber: 'P1',
      vendorId: refs.vendorA,
      deliveryRoute: 'WAREHOUSE',
      poDate: '2026-01-05',
    });
    await createPurchaseOrder({
      poNumber: 'P2',
      vendorId: refs.vendorB,
      deliveryRoute: 'DIRECT',
      destinationDivisionId: refs.divisionA1,
      targetWarehouseId: null,
      poDate: '2026-01-12',
    });

    const vendorRes = await get(`/purchase-orders?vendorId=${refs.vendorA}`);
    expect(vendorRes.body.items).toHaveLength(1);
    expect(vendorRes.body.items[0].poNumber).toBe('P1');

    const routeRes = await get('/purchase-orders?deliveryRoute=DIRECT');
    expect(routeRes.body.items).toHaveLength(1);
    expect(routeRes.body.items[0].poNumber).toBe('P2');

    // Cancel po1
    await send('post', `/purchase-orders/${po1.id}/cancel`, {
      rev: po1.rev,
      reason: 'Cancelled for test',
    });

    const openRes = await get('/purchase-orders?status=open');
    expect(openRes.body.items).toHaveLength(1);
    expect(openRes.body.items[0].poNumber).toBe('P2');

    const cancelledRes = await get('/purchase-orders?status=cancelled');
    expect(cancelledRes.body.items).toHaveLength(1);
    expect(cancelledRes.body.items[0].poNumber).toBe('P1');
  });

  it('counts active purchase orders on the dashboard from real data', async () => {
    const po1 = await createPurchaseOrder({ poNumber: 'P1' });
    await createPurchaseOrder({ poNumber: 'P2' });

    const res1 = await get('/dashboard/summary');
    const summary1 = dashboardSummarySchema.parse(res1.body);
    const poInd1 = summary1.indicators.find((i) => i.key === 'activePurchaseOrders');
    expect(poInd1?.status).toBe('available');
    expect(poInd1?.value).toBe(2);

    // Cancel po1
    await send('post', `/purchase-orders/${po1.id}/cancel`, {
      rev: po1.rev,
      reason: 'Cancelled order',
    });

    const res2 = await get('/dashboard/summary');
    const summary2 = dashboardSummarySchema.parse(res2.body);
    const poInd2 = summary2.indicators.find((i) => i.key === 'activePurchaseOrders');
    expect(poInd2?.value).toBe(1);
  });
});

describe('permissions and role enforcement', () => {
  it('requires a session and CSRF token for writes', async () => {
    await request(app).post('/api/purchase-orders').send(validPurchaseOrder()).expect(401);

    await request(app)
      .post('/api/purchase-orders')
      .set('Cookie', operator.cookie)
      .send(validPurchaseOrder())
      .expect(403); // missing CSRF token
  });

  it('lets read-only viewers read but never create, edit or cancel', async () => {
    const po = await createPurchaseOrder();

    // Viewer can list and get
    const listRes = await get('/purchase-orders', viewer);
    expect(listRes.status).toBe(200);

    const getRes = await get(`/purchase-orders/${po.id}`, viewer);
    expect(getRes.status).toBe(200);

    // Viewer cannot create
    const createRes = await send(
      'post',
      '/purchase-orders',
      validPurchaseOrder({ poNumber: 'V1' }),
      viewer,
    );
    expect(createRes.status).toBe(403);

    // Viewer cannot edit
    const editRes = await send(
      'patch',
      `/purchase-orders/${po.id}`,
      { rev: po.rev, notes: 'Viewer edit' },
      viewer,
    );
    expect(editRes.status).toBe(403);

    // Viewer cannot cancel
    const cancelRes = await send(
      'post',
      `/purchase-orders/${po.id}/cancel`,
      { rev: po.rev, reason: 'Viewer cancel' },
      viewer,
    );
    expect(cancelRes.status).toBe(403);
  });
});
