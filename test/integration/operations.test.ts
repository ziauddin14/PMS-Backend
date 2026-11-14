import type { Express } from 'express';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/authService.js';
import { ensureAuthCollections } from '../../src/auth/collections.js';
import { UserAdmin } from '../../src/auth/userAdmin.js';
import {
  dashboardSummarySchema,
  demandDetailSchema,
  purchaseOrderDetailSchema,
} from '../../src/contracts/api.js';
import {
  dispatchDetailSchema,
  paymentSchema,
  receiptDetailSchema,
  reportResponseSchema,
  stockBalanceResponseSchema,
  stockMovementResponseSchema,
  syncSummarySchema,
} from '../../src/contracts/operations.js';
import { COLLECTIONS, ensureInfrastructureCollections } from '../../src/db/collections.js';
import { connectToDatabase, type Database } from '../../src/db/mongo.js';
import { ensureDemandCollections } from '../../src/demands/definitions.js';
import { DemandService, todayInKarachi } from '../../src/demands/demandService.js';
import { createApp } from '../../src/http/app.js';
import { ensureMasterDataCollections } from '../../src/masterData/definitions.js';
import { MasterDataService } from '../../src/masterData/masterDataService.js';
import { createOperations, ensureOperationsCollections } from '../../src/operations.js';
import { ensurePurchaseOrderCollections } from '../../src/purchaseOrders/definitions.js';
import { PurchaseOrderService } from '../../src/purchaseOrders/purchaseOrderService.js';
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
const today = todayInKarachi();

let refs: {
  province: string;
  divisionA: string;
  divisionB: string;
  department: string;
  itemBox: string;
  itemBook: string;
  vendor: string;
  warehouse: string;
};

beforeAll(async () => {
  replSet = await startReplicaSet();
  const config = testConfig({
    MONGODB_URI: replSet.getUri(),
    MONGODB_DB_NAME: 'pms_operations_test',
    RATE_LIMIT_MAX: '100000',
    LOGIN_RATE_LIMIT_MAX: '1000',
  });
  const captured = capturingLogger();
  database = await connectToDatabase(config.mongodb, captured.logger);
  const store = new RecordStore(database);
  app = createApp({
    config,
    logger: captured.logger,
    database,
    authService: new AuthService(database, config.auth),
    masterDataService: new MasterDataService(database, store),
    demandService: new DemandService(database, store),
    purchaseOrderService: new PurchaseOrderService(database, store),
    operations: createOperations(database, store),
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
  await ensureOperationsCollections(database.db);
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
  const province = await master('provinces', { name: 'Synthetic Province' });
  refs = {
    province,
    divisionA: await master('divisions', { name: 'Synthetic Division A', provinceId: province }),
    divisionB: await master('divisions', { name: 'Synthetic Division B', provinceId: province }),
    department: await master('departments', { name: 'Synthetic Department' }),
    itemBox: await master('items', { name: 'Synthetic Box' }),
    itemBook: await master('items', { name: 'Synthetic Book' }),
    vendor: await master('vendors', { name: 'Synthetic Vendor' }),
    warehouse: await master('warehouses', { name: 'Synthetic Warehouse' }),
  };
});

async function createDemand(
  lines: Array<{ itemId: string; destinationDivisionId: string; quantity: number }>,
) {
  const res = await send('post', '/demands', {
    demandDate: today,
    departmentId: refs.department,
    provinceId: refs.province,
    lines,
  }).expect(201);
  return demandDetailSchema.parse(res.body);
}

async function createPo(overrides: Record<string, unknown> = {}) {
  const res = await send('post', '/purchase-orders', {
    poNumber: `SYN/${new ObjectId().toHexString().slice(-6)}`,
    poDate: today,
    vendorId: refs.vendor,
    deliveryRoute: 'WAREHOUSE',
    targetWarehouseId: refs.warehouse,
    approvedAmount: 10000,
    lines: [{ itemId: refs.itemBox, quantityOrdered: 100, unitPrice: 50 }],
    ...overrides,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return purchaseOrderDetailSchema.parse(res.body);
}

function receive(poId: string, lines: Array<{ poLineId: string; quantity: number }>) {
  return send('post', '/receipts', { purchaseOrderId: poId, receiptDate: today, lines });
}

describe('Scenario A — warehouse route end to end', () => {
  it('demand → PO → partial and full receipt → stock → dispatch → payments → reports', async () => {
    const demand = await createDemand([
      { itemId: refs.itemBox, destinationDivisionId: refs.divisionA, quantity: 60 },
    ]);
    const demandLine = demand.lines[0]!;
    const po = await createPo({
      lines: [
        {
          itemId: refs.itemBox,
          quantityOrdered: 100,
          unitPrice: 50,
          demandId: demand.id,
          demandLineId: demandLine.id,
        },
      ],
      paymentSchedule: [
        { dueDate: today, plannedAmount: 4000 },
        { dueDate: today, plannedAmount: 1000 },
      ],
    });
    const poLine = po.lines[0]!;
    expect(po.completion).toBe('PENDING');

    // Partial receipt.
    const r1 = await receive(po.id, [{ poLineId: poLine.id, quantity: 40 }]).expect(201);
    const receipt1 = receiptDetailSchema.parse(r1.body);
    expect(receipt1.code).toMatch(/^GRN-\d{6}$/);
    expect(receipt1.location).toMatchObject({ kind: 'WAREHOUSE', id: refs.warehouse });
    let poNow = purchaseOrderDetailSchema.parse(
      (await get(`/purchase-orders/${po.id}`).expect(200)).body,
    );
    expect(poNow.completion).toBe('PARTIAL');
    expect(poNow.lines[0]).toMatchObject({
      quantityReceived: 40,
      quantityRemaining: 60,
      completion: 'PARTIAL',
    });

    // Over-receipt is rejected with a field error.
    const over = await receive(po.id, [{ poLineId: poLine.id, quantity: 61 }]).expect(400);
    expect(over.body.error.details[0].path).toBe('lines.0.quantity');

    // Remaining goods.
    await receive(po.id, [{ poLineId: poLine.id, quantity: 60 }]).expect(201);
    poNow = purchaseOrderDetailSchema.parse(
      (await get(`/purchase-orders/${po.id}`).expect(200)).body,
    );
    expect(poNow.completion).toBe('COMPLETE');
    expect(poNow.totalReceived).toBe(100);
    // Payment status is independent of completion.
    expect(poNow.paymentStatus).toBe('UNPAID');

    // Warehouse stock.
    const stock = stockBalanceResponseSchema.parse(
      (await get(`/stock/balances?locationKind=WAREHOUSE&locationId=${refs.warehouse}`).expect(200))
        .body,
    );
    expect(stock.totalQuantity).toBe(100);
    expect(stock.items[0]?.lot.poNumber).toBe(po.poNumber);

    // Dispatch 50 of 60 demanded to division A against the demand line.
    const d1 = await send('post', '/dispatches', {
      dispatchDate: today,
      sourceKind: 'WAREHOUSE',
      sourceId: refs.warehouse,
      destinationDivisionId: refs.divisionA,
      demandId: demand.id,
      biltyNo: 'BLT-SYN-1',
      transporterName: 'Synthetic Transport',
      documents: [{ label: 'Bilty scan', url: 'https://example.invalid/bilty.pdf' }],
      lines: [{ poLineId: poLine.id, quantity: 50, demandLineId: demandLine.id }],
    });
    expect(d1.status, JSON.stringify(d1.body)).toBe(201);
    const dispatch = dispatchDetailSchema.parse(d1.body);
    expect(dispatch.code).toMatch(/^DSP-\d{6}$/);
    expect(dispatch.lines[0]?.demandLine).toMatchObject({ demandCode: demand.code, lineNo: 1 });

    // Dispatch never changes PO completion; demand shows partial fulfilment.
    poNow = purchaseOrderDetailSchema.parse(
      (await get(`/purchase-orders/${po.id}`).expect(200)).body,
    );
    expect(poNow.completion).toBe('COMPLETE');
    const demandNow = demandDetailSchema.parse(
      (await get(`/demands/${demand.id}`).expect(200)).body,
    );
    expect(demandNow.fulfilment).toBe('PARTIAL');
    expect(demandNow.lines[0]).toMatchObject({ quantityDelivered: 50, quantityRemaining: 10 });

    // Over-delivery of the demand line is rejected.
    await send('post', '/dispatches', {
      dispatchDate: today,
      sourceKind: 'WAREHOUSE',
      sourceId: refs.warehouse,
      destinationDivisionId: refs.divisionA,
      demandId: demand.id,
      lines: [{ poLineId: poLine.id, quantity: 11, demandLineId: demandLine.id }],
    }).expect(400);

    // Ledger: 2 receipts in, 1 dispatch out → balance 50.
    const ledger = stockMovementResponseSchema.parse(
      (await get('/stock/movements').expect(200)).body,
    );
    expect(ledger.items.map((m) => m.quantity).sort((a, b) => a - b)).toEqual([-50, 40, 60]);
    const after = stockBalanceResponseSchema.parse((await get('/stock/balances').expect(200)).body);
    expect(after.totalQuantity).toBe(50);

    // Bilty details can be completed later.
    const patched = await send('patch', `/dispatches/${dispatch.id}`, {
      rev: dispatch.rev,
      vehicleNo: 'SYN-123',
    }).expect(200);
    expect(patched.body.vehicleNo).toBe('SYN-123');

    // Payments: instalments, cap at approved amount.
    const p1 = paymentSchema.parse(
      (
        await send('post', '/payments', {
          purchaseOrderId: po.id,
          paymentDate: today,
          amount: 4000,
          method: 'BANK_TRANSFER',
          reference: 'SYN-TXN-1',
          scheduleEntryNo: 1,
        }).expect(201)
      ).body,
    );
    expect(p1.code).toMatch(/^PAY-\d{6}$/);
    const tooMuch = await send('post', '/payments', {
      purchaseOrderId: po.id,
      paymentDate: today,
      amount: 6000.01,
      method: 'CHEQUE',
    }).expect(400);
    expect(tooMuch.body.error.details[0].path).toBe('amount');
    poNow = purchaseOrderDetailSchema.parse(
      (await get(`/purchase-orders/${po.id}`).expect(200)).body,
    );
    expect(poNow).toMatchObject({
      paidAmount: 4000,
      outstandingAmount: 6000,
      paymentStatus: 'PARTIAL',
    });
    // Approved amount cannot go below what was paid.
    await send('patch', `/purchase-orders/${po.id}`, {
      rev: poNow.rev,
      approvedAmount: 3999,
    }).expect(400);
    // Received lines cannot be reduced below the received quantity or removed.
    const reduce = await send('patch', `/purchase-orders/${po.id}`, {
      rev: poNow.rev,
      lines: [{ id: poLine.id, itemId: refs.itemBox, quantityOrdered: 90, unitPrice: 50 }],
    }).expect(400);
    expect(JSON.stringify(reduce.body)).toContain('already received');

    // Dashboard figures are real.
    const dash = dashboardSummarySchema.parse((await get('/dashboard/summary').expect(200)).body);
    const value = (key: string) => dash.indicators.find((i) => i.key === key)?.value;
    expect(value('stockLots')).toBe(50);
    expect(value('dispatchesThisMonth')).toBe(1);
    expect(value('outstandingVendorPayments')).toBe(6000);
    expect(value('activePurchaseOrders')).toBe(0);
    expect(value('openDemands')).toBe(1);

    // Reports (JSON + CSV) for every report key.
    for (const key of [
      'purchase-orders',
      'receipts',
      'stock',
      'dispatches',
      'payments',
      'demands',
      'vendors',
    ]) {
      const report = reportResponseSchema.parse(
        (await get(`/reports/${key}`, viewer).expect(200)).body,
      );
      expect(report.rows.length, key).toBeGreaterThan(0);
    }
    const po_report = reportResponseSchema.parse(
      (await get('/reports/purchase-orders').expect(200)).body,
    );
    expect(po_report.rows[0]).toMatchObject({ completion: 'COMPLETE', received: 100, paid: 4000 });
    expect(po_report.totals.outstanding).toBe(6000);
    const csv = await get('/reports/dispatches?format=csv').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('BLT-SYN-1');

    // Audit and sync outbox.
    const audits = await database.db.collection(COLLECTIONS.auditEvents).countDocuments({
      'entity.collection': { $in: ['receipts', 'dispatches', 'vendor_payments'] },
    });
    expect(audits).toBe(5); // 2 receipts + dispatch create + dispatch update + 1 payment
    const sync = syncSummarySchema.parse((await get('/sync/summary', viewer).expect(200)).body);
    expect(sync.processorEnabled).toBe(false);
    expect(sync.byTarget.some((t) => t.workbook === 'STOCK')).toBe(true);
  });
});

describe('Scenario B — direct route', () => {
  it('receives at the division, never into warehouse stock, and hands over to the demand', async () => {
    const demand = await createDemand([
      { itemId: refs.itemBook, destinationDivisionId: refs.divisionB, quantity: 30 },
    ]);
    const po = await createPo({
      deliveryRoute: 'DIRECT',
      targetWarehouseId: null,
      destinationDivisionId: refs.divisionB,
      lines: [{ itemId: refs.itemBook, quantityOrdered: 30, unitPrice: 10 }],
    });
    const receipt = receiptDetailSchema.parse(
      (await receive(po.id, [{ poLineId: po.lines[0]!.id, quantity: 30 }]).expect(201)).body,
    );
    expect(receipt.location).toMatchObject({ kind: 'DIVISION', id: refs.divisionB });

    const warehouseStock = stockBalanceResponseSchema.parse(
      (await get('/stock/balances?locationKind=WAREHOUSE').expect(200)).body,
    );
    expect(warehouseStock.totalQuantity).toBe(0);
    const divisionStock = stockBalanceResponseSchema.parse(
      (await get(`/stock/balances?locationKind=DIVISION&locationId=${refs.divisionB}`).expect(200))
        .body,
    );
    expect(divisionStock.totalQuantity).toBe(30);
    const poNow = purchaseOrderDetailSchema.parse(
      (await get(`/purchase-orders/${po.id}`).expect(200)).body,
    );
    expect(poNow.completion).toBe('COMPLETE');
    const dash = dashboardSummarySchema.parse((await get('/dashboard/summary').expect(200)).body);
    expect(dash.indicators.find((i) => i.key === 'stockLots')?.value).toBe(0);

    // Direct goods can only be handed over within the same division.
    await send('post', '/dispatches', {
      dispatchDate: today,
      sourceKind: 'DIVISION',
      sourceId: refs.divisionB,
      destinationDivisionId: refs.divisionA,
      lines: [{ poLineId: po.lines[0]!.id, quantity: 1 }],
    }).expect(400);
    await send('post', '/dispatches', {
      dispatchDate: today,
      sourceKind: 'DIVISION',
      sourceId: refs.divisionB,
      destinationDivisionId: refs.divisionB,
      demandId: demand.id,
      lines: [{ poLineId: po.lines[0]!.id, quantity: 30, demandLineId: demand.lines[0]!.id }],
    }).expect(201);
    const demandNow = demandDetailSchema.parse(
      (await get(`/demands/${demand.id}`).expect(200)).body,
    );
    expect(demandNow.fulfilment).toBe('DELIVERED');
  });
});

describe('Scenario C — partial operations, guards and concurrency', () => {
  it('blocks viewers from every write and requires CSRF', async () => {
    const po = await createPo();
    const body = {
      purchaseOrderId: po.id,
      receiptDate: today,
      lines: [{ poLineId: po.lines[0]!.id, quantity: 1 }],
    };
    const v = await send('post', '/receipts', body, viewer).expect(403);
    expect(v.body.error.code).toBe('FORBIDDEN');
    await request(app).post('/api/receipts').set('Cookie', operator.cookie).send(body).expect(403);
    await send(
      'post',
      '/payments',
      { purchaseOrderId: po.id, paymentDate: today, amount: 1, method: 'CASH' },
      viewer,
    ).expect(403);
    await send('post', '/dispatches', {}, viewer).expect(403);
    await request(app).get('/api/receipts').expect(401);
    await get('/receipts', viewer).expect(200);
  });

  it('prevents double counting under concurrent duplicate receipts', async () => {
    const po = await createPo();
    const line = po.lines[0]!.id;
    const results = await Promise.all(
      Array.from({ length: 6 }, () => receive(po.id, [{ poLineId: line, quantity: 30 }])),
    );
    const ok = results.filter((r) => r.status === 201).length;
    expect(ok).toBe(3);
    for (const r of results) expect([201, 400, 409]).toContain(r.status);
    const poNow = purchaseOrderDetailSchema.parse(
      (await get(`/purchase-orders/${po.id}`).expect(200)).body,
    );
    expect(poNow.totalReceived).toBe(90);
    const stock = stockBalanceResponseSchema.parse((await get('/stock/balances').expect(200)).body);
    expect(stock.totalQuantity).toBe(90);
  });

  it('prevents overpayment under concurrent payments', async () => {
    const po = await createPo({ approvedAmount: 1000 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        send('post', '/payments', {
          purchaseOrderId: po.id,
          paymentDate: today,
          amount: 300,
          method: 'CASH',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    const poNow = purchaseOrderDetailSchema.parse(
      (await get(`/purchase-orders/${po.id}`).expect(200)).body,
    );
    expect(poNow.paidAmount).toBe(900);
  });

  it('returns a formatted 400 (not 500) for concurrent duplicate PO numbers', async () => {
    const body = {
      poNumber: 'SYN/DUP-1',
      poDate: today,
      vendorId: refs.vendor,
      deliveryRoute: 'WAREHOUSE',
      targetWarehouseId: refs.warehouse,
      approvedAmount: 1,
      lines: [{ itemId: refs.itemBox, quantityOrdered: 1, unitPrice: 1 }],
    };
    const results = await Promise.all(
      Array.from({ length: 4 }, () => send('post', '/purchase-orders', body)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(400);
      expect(r.body.error.details[0].path).toBe('poNumber');
    }
  });

  it('cancelling records reverses stock in the right order and keeps history', async () => {
    const demand = await createDemand([
      { itemId: refs.itemBox, destinationDivisionId: refs.divisionA, quantity: 10 },
    ]);
    const po = await createPo();
    const line = po.lines[0]!.id;
    const receipt = receiptDetailSchema.parse(
      (await receive(po.id, [{ poLineId: line, quantity: 10 }]).expect(201)).body,
    );
    const dispatch = dispatchDetailSchema.parse(
      (
        await send('post', '/dispatches', {
          dispatchDate: today,
          sourceKind: 'WAREHOUSE',
          sourceId: refs.warehouse,
          destinationDivisionId: refs.divisionA,
          demandId: demand.id,
          lines: [{ poLineId: line, quantity: 10, demandLineId: demand.lines[0]!.id }],
        }).expect(201)
      ).body,
    );
    // PO and demand cannot be cancelled while receipts / dispatches exist.
    const poNow = purchaseOrderDetailSchema.parse(
      (await get(`/purchase-orders/${po.id}`).expect(200)).body,
    );
    await send('post', `/purchase-orders/${po.id}/cancel`, { rev: poNow.rev, reason: 'x' }).expect(
      409,
    );
    await send('post', `/demands/${demand.id}/cancel`, { rev: demand.rev, reason: 'x' }).expect(
      409,
    );
    // Receipt cannot be cancelled while its stock is dispatched.
    const blocked = await send('post', `/receipts/${receipt.id}/cancel`, {
      rev: receipt.rev,
      reason: 'wrong',
    }).expect(409);
    expect(blocked.body.error.message).toContain('dispatched');
    // Stale revision.
    await send('post', `/dispatches/${dispatch.id}/cancel`, {
      rev: dispatch.rev + 5,
      reason: 'x',
    }).expect(409);
    // Cancel dispatch, then receipt, then PO.
    await send('post', `/dispatches/${dispatch.id}/cancel`, {
      rev: dispatch.rev,
      reason: 'Wrong division',
    }).expect(200);
    const d = demandDetailSchema.parse((await get(`/demands/${demand.id}`).expect(200)).body);
    expect(d.lines[0]?.quantityDelivered).toBe(0);
    await send('post', `/receipts/${receipt.id}/cancel`, {
      rev: receipt.rev,
      reason: 'Entered twice',
    }).expect(200);
    const fresh = purchaseOrderDetailSchema.parse(
      (await get(`/purchase-orders/${po.id}`).expect(200)).body,
    );
    expect(fresh.completion).toBe('PENDING');
    await send('post', `/purchase-orders/${po.id}/cancel`, {
      rev: fresh.rev,
      reason: 'Not needed',
    }).expect(200);
    // Cancelled PO accepts no receipts.
    await receive(po.id, [{ poLineId: line, quantity: 1 }]).expect(409);
    const ledger = stockMovementResponseSchema.parse(
      (await get('/stock/movements').expect(200)).body,
    );
    expect(ledger.total).toBe(4);
    expect(ledger.items.reduce((s, m) => s + m.quantity, 0)).toBe(0);
    const cancelled = await get('/receipts?status=cancelled').expect(200);
    expect(cancelled.body.total).toBe(1);
  });

  it('rejects invalid references and cross-PO lines', async () => {
    const po1 = await createPo();
    const po2 = await createPo();
    const res = await receive(po1.id, [{ poLineId: po2.lines[0]!.id, quantity: 1 }]).expect(400);
    expect(res.body.error.details[0].path).toBe('lines.0.poLineId');
    await receive(new ObjectId().toHexString(), [
      { poLineId: po1.lines[0]!.id, quantity: 1 },
    ]).expect(400);
    await get(`/receipts/${new ObjectId().toHexString()}`).expect(404);
    await get('/reports/unknown').expect(404);
    const future = await send('post', '/receipts', {
      purchaseOrderId: po1.id,
      receiptDate: '2999-01-01',
      lines: [{ poLineId: po1.lines[0]!.id, quantity: 1 }],
    }).expect(400);
    expect(future.body.error.details[0].path).toBe('receiptDate');
    // Not enough stock to dispatch.
    const noStock = await send('post', '/dispatches', {
      dispatchDate: today,
      sourceKind: 'WAREHOUSE',
      sourceId: refs.warehouse,
      destinationDivisionId: refs.divisionA,
      lines: [{ poLineId: po1.lines[0]!.id, quantity: 1 }],
    }).expect(400);
    expect(noStock.body.error.details[0].message).toContain('in stock');
  });

  it('re-queues failed sync jobs for the operator only', async () => {
    await createPo();
    const job = await database.db.collection(COLLECTIONS.syncJobs).findOne({});
    await database.db
      .collection(COLLECTIONS.syncJobs)
      .updateOne({ _id: job!._id }, { $set: { status: 'FAILED', lastError: 'synthetic' } });
    const id = job!._id.toHexString();
    await send('post', `/sync/jobs/${id}/retry`, {}, viewer).expect(403);
    const res = await send('post', `/sync/jobs/${id}/retry`, {}).expect(200);
    expect(res.body.status).toBe('RETRY');
    await send('post', `/sync/jobs/${id}/retry`, {}).expect(409);
    const list = await get('/sync/jobs?status=RETRY').expect(200);
    expect(list.body.total).toBe(1);
  });
});
