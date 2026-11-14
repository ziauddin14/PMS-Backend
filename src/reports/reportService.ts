import { ObjectId, type Document, type Filter } from 'mongodb';
import type { MasterRef } from '../contracts/api.js';
import type { ReportKey, ReportQuery, ReportResponse } from '../contracts/operations.js';
import type { Database } from '../db/mongo.js';
import { DEMANDS_COLLECTION, type DemandDoc } from '../demands/definitions.js';
import { DISPATCHES_COLLECTION, type DispatchDoc } from '../dispatch/dispatchDefinitions.js';
import {
  STOCK_BALANCES,
  fetchMasterMap,
  readTallies,
  refOf,
  tallyKey,
  toCents,
  type RefDocs,
  type StockBalanceDoc,
} from '../inventory/ledger.js';
import { RECEIPTS_COLLECTION, type ReceiptDoc } from '../inventory/receiptDefinitions.js';
import { PAYMENTS_COLLECTION, type PaymentDoc } from '../payments/paymentService.js';
import {
  PURCHASE_ORDERS_COLLECTION,
  type PurchaseOrderDoc,
} from '../purchaseOrders/definitions.js';

export const REPORT_ROW_LIMIT = 5000;
/** UTF-8 byte-order mark so Excel opens Urdu/Arabic text in the CSV correctly. */
const BOM = String.fromCharCode(0xfeff);

type Cell = string | number | null;
type Column = ReportResponse['columns'][number];

const TITLES: Record<ReportKey, string> = {
  'purchase-orders': 'Purchase orders — completion and payments',
  receipts: 'Goods received (by line)',
  stock: 'Stock on hand (by location and PO lot)',
  dispatches: 'Dispatches and Bilty (by line)',
  payments: 'Vendor payments',
  demands: 'Demand fulfilment (by line)',
  vendors: 'Vendor summary',
};

const text = (key: string, label: string): Column => ({ key, label, type: 'text' });
const num = (key: string, label: string): Column => ({ key, label, type: 'number' });
const money = (key: string, label: string): Column => ({ key, label, type: 'money' });

/**
 * Reports (M11). Read-only, role-checked at the route. Personal data (receiver names/phones)
 * is never included. Each report is capped at REPORT_ROW_LIMIT rows (`truncated` tells the user).
 */
export class ReportService {
  constructor(private readonly database: Database) {}

  private get db() {
    return this.database.db;
  }

  async run(key: ReportKey, query: ReportQuery): Promise<ReportResponse> {
    const result = await this.build(key, query);
    const totals: Record<string, number> = {};
    for (const column of result.columns) {
      if (column.type === 'text') continue;
      let sum = 0;
      for (const row of result.rows) {
        const value = row[column.key];
        if (typeof value === 'number') sum += value;
      }
      totals[column.key] = column.type === 'money' ? Math.round(sum * 100) / 100 : sum;
    }
    return {
      key,
      title: TITLES[key],
      generatedAt: new Date().toISOString(),
      columns: result.columns,
      rows: result.rows.slice(0, REPORT_ROW_LIMIT),
      totals,
      truncated: result.rows.length > REPORT_ROW_LIMIT,
    };
  }

  private build(
    key: ReportKey,
    q: ReportQuery,
  ): Promise<{ columns: Column[]; rows: Array<Record<string, Cell>> }> {
    switch (key) {
      case 'purchase-orders':
        return this.purchaseOrders(q);
      case 'receipts':
        return this.receipts(q);
      case 'stock':
        return this.stock(q);
      case 'dispatches':
        return this.dispatches(q);
      case 'payments':
        return this.payments(q);
      case 'demands':
        return this.demands(q);
      case 'vendors':
        return this.vendors(q);
    }
  }

  private lifecycle(q: ReportQuery): Document {
    return q.includeCancelled === 'true' ? {} : { 'lifecycle.state': 'ACTIVE' };
  }

  private range(field: string, q: ReportQuery): Document {
    if (!q.from && !q.to) return {};
    return { [field]: { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) } };
  }

  private async poDocs(q: ReportQuery): Promise<PurchaseOrderDoc[]> {
    const filter: Filter<PurchaseOrderDoc> = { ...this.lifecycle(q), ...this.range('poDate', q) };
    if (q.vendorId) filter.vendorId = new ObjectId(q.vendorId);
    if (q.itemId) filter['lines.itemId'] = new ObjectId(q.itemId);
    if (q.warehouseId) filter.targetWarehouseId = new ObjectId(q.warehouseId);
    if (q.divisionId) filter.destinationDivisionId = new ObjectId(q.divisionId);
    return this.db
      .collection<PurchaseOrderDoc>(PURCHASE_ORDERS_COLLECTION)
      .find(filter)
      .sort({ poDate: 1, code: 1 })
      .limit(REPORT_ROW_LIMIT + 1)
      .toArray();
  }

  private async poProgress(docs: PurchaseOrderDoc[]) {
    const keys = docs.flatMap((doc) => [
      tallyKey.paidCents(doc._id),
      ...doc.lines.map((line) => tallyKey.received(line._id)),
    ]);
    const values = await readTallies(this.db, keys);
    return (doc: PurchaseOrderDoc) => {
      const ordered = doc.lines.reduce((s, l) => s + l.quantityOrdered, 0);
      const received = doc.lines.reduce(
        (s, l) => s + Math.min(l.quantityOrdered, values.get(tallyKey.received(l._id)) ?? 0),
        0,
      );
      const paidCents = values.get(tallyKey.paidCents(doc._id)) ?? 0;
      const approvedCents = toCents(doc.approvedAmount);
      const completion =
        received === 0
          ? 'PENDING'
          : doc.lines.every((l) => (values.get(tallyKey.received(l._id)) ?? 0) >= l.quantityOrdered)
            ? 'COMPLETE'
            : 'PARTIAL';
      const paymentStatus =
        paidCents === 0 ? 'UNPAID' : paidCents >= approvedCents ? 'PAID' : 'PARTIAL';
      return { ordered, received, paidCents, approvedCents, completion, paymentStatus };
    };
  }

  private async purchaseOrders(q: ReportQuery) {
    const docs = await this.poDocs(q);
    const [vendors, warehouses, divisions, progressOf] = await Promise.all([
      fetchMasterMap(
        this.db,
        'vendors',
        docs.map((d) => d.vendorId.toHexString()),
      ),
      fetchMasterMap(
        this.db,
        'warehouses',
        docs.flatMap((d) => (d.targetWarehouseId ? [d.targetWarehouseId.toHexString()] : [])),
      ),
      fetchMasterMap(
        this.db,
        'divisions',
        docs.flatMap((d) =>
          d.destinationDivisionId ? [d.destinationDivisionId.toHexString()] : [],
        ),
      ),
      this.poProgress(docs),
    ]);
    const rows = docs.map((doc) => {
      const p = progressOf(doc);
      return {
        code: doc.code,
        poNumber: doc.poNumber,
        poDate: doc.poDate,
        vendor: name(refOf(vendors, doc.vendorId)),
        route: doc.deliveryRoute === 'WAREHOUSE' ? 'Warehouse' : 'Direct',
        location: doc.targetWarehouseId
          ? name(refOf(warehouses, doc.targetWarehouseId))
          : doc.destinationDivisionId
            ? name(refOf(divisions, doc.destinationDivisionId))
            : null,
        status: doc.lifecycle.state === 'ACTIVE' ? 'Open' : 'Cancelled',
        completion: p.completion,
        ordered: p.ordered,
        received: p.received,
        approved: doc.approvedAmount,
        paid: p.paidCents / 100,
        outstanding: Math.max(0, p.approvedCents - p.paidCents) / 100,
        paymentStatus: p.paymentStatus,
      } satisfies Record<string, Cell>;
    });
    return {
      columns: [
        text('code', 'PMS ID'),
        text('poNumber', 'PO number'),
        text('poDate', 'PO date'),
        text('vendor', 'Vendor'),
        text('route', 'Route'),
        text('location', 'Warehouse / division'),
        text('status', 'Status'),
        text('completion', 'Completion'),
        num('ordered', 'Ordered'),
        num('received', 'Received'),
        money('approved', 'Approved'),
        money('paid', 'Paid'),
        money('outstanding', 'Outstanding'),
        text('paymentStatus', 'Payment'),
      ],
      rows,
    };
  }

  private async receipts(q: ReportQuery) {
    const filter: Filter<ReceiptDoc> = { ...this.lifecycle(q), ...this.range('receiptDate', q) };
    if (q.vendorId) filter.vendorId = new ObjectId(q.vendorId);
    if (q.itemId) filter['lines.itemId'] = new ObjectId(q.itemId);
    if (q.warehouseId)
      Object.assign(filter, { locationKind: 'WAREHOUSE', locationId: new ObjectId(q.warehouseId) });
    if (q.divisionId)
      Object.assign(filter, { locationKind: 'DIVISION', locationId: new ObjectId(q.divisionId) });
    const docs = await this.db
      .collection<ReceiptDoc>(RECEIPTS_COLLECTION)
      .find(filter)
      .sort({ receiptDate: 1, code: 1 })
      .limit(REPORT_ROW_LIMIT + 1)
      .toArray();
    const [vendors, items, warehouses, divisions] = await Promise.all([
      fetchMasterMap(
        this.db,
        'vendors',
        docs.map((d) => d.vendorId.toHexString()),
      ),
      fetchMasterMap(
        this.db,
        'items',
        docs.flatMap((d) => d.lines.map((l) => l.itemId.toHexString())),
      ),
      fetchMasterMap(
        this.db,
        'warehouses',
        docs.filter((d) => d.locationKind === 'WAREHOUSE').map((d) => d.locationId.toHexString()),
      ),
      fetchMasterMap(
        this.db,
        'divisions',
        docs.filter((d) => d.locationKind === 'DIVISION').map((d) => d.locationId.toHexString()),
      ),
    ]);
    const rows = docs.flatMap((doc) =>
      doc.lines
        .filter((line) => !q.itemId || line.itemId.equals(new ObjectId(q.itemId)))
        .map((line) => ({
          code: doc.code,
          receiptDate: doc.receiptDate,
          poNumber: doc.poNumber,
          vendor: name(refOf(vendors, doc.vendorId)),
          location: `${doc.locationKind === 'WAREHOUSE' ? 'Warehouse' : 'Division (direct)'}: ${name(
            refOf(doc.locationKind === 'WAREHOUSE' ? warehouses : divisions, doc.locationId),
          )}`,
          challan: doc.vendorChallanNo,
          item: name(refOf(items, line.itemId)),
          poLineNo: line.poLineNo,
          quantity: line.quantity,
          status: doc.lifecycle.state === 'ACTIVE' ? 'Active' : 'Cancelled',
        })),
    );
    return {
      columns: [
        text('code', 'Receipt'),
        text('receiptDate', 'Date'),
        text('poNumber', 'PO number'),
        text('vendor', 'Vendor'),
        text('location', 'Received at'),
        text('challan', 'Vendor challan'),
        text('item', 'Item'),
        num('poLineNo', 'PO line'),
        num('quantity', 'Quantity'),
        text('status', 'Status'),
      ],
      rows,
    };
  }

  private async stock(q: ReportQuery) {
    const filter: Filter<StockBalanceDoc> = { quantity: { $gt: 0 } };
    if (q.itemId) filter.itemId = new ObjectId(q.itemId);
    if (q.warehouseId)
      Object.assign(filter, { locationKind: 'WAREHOUSE', locationId: new ObjectId(q.warehouseId) });
    if (q.divisionId)
      Object.assign(filter, { locationKind: 'DIVISION', locationId: new ObjectId(q.divisionId) });
    if (q.vendorId) {
      const poIds = await this.db
        .collection<PurchaseOrderDoc>(PURCHASE_ORDERS_COLLECTION)
        .find({ vendorId: new ObjectId(q.vendorId) }, { projection: { _id: 1 } })
        .toArray();
      filter.purchaseOrderId = { $in: poIds.map((p) => p._id) };
    }
    const docs = await this.db
      .collection<StockBalanceDoc>(STOCK_BALANCES)
      .find(filter)
      .sort({ locationKind: -1, locationId: 1, itemId: 1 })
      .limit(REPORT_ROW_LIMIT + 1)
      .toArray();
    const poIds = [...new Set(docs.map((d) => d.purchaseOrderId.toHexString()))];
    const [items, warehouses, divisions, pos] = await Promise.all([
      fetchMasterMap(
        this.db,
        'items',
        docs.map((d) => d.itemId.toHexString()),
      ),
      fetchMasterMap(
        this.db,
        'warehouses',
        docs.filter((d) => d.locationKind === 'WAREHOUSE').map((d) => d.locationId.toHexString()),
      ),
      fetchMasterMap(
        this.db,
        'divisions',
        docs.filter((d) => d.locationKind === 'DIVISION').map((d) => d.locationId.toHexString()),
      ),
      this.db
        .collection<PurchaseOrderDoc>(PURCHASE_ORDERS_COLLECTION)
        .find({ _id: { $in: poIds.map((id) => new ObjectId(id)) } })
        .toArray(),
    ]);
    const poMap = new Map(pos.map((p) => [p._id.toHexString(), p]));
    const vendors = await fetchMasterMap(
      this.db,
      'vendors',
      pos.map((p) => p.vendorId.toHexString()),
    );
    const rows = docs.map((doc) => {
      const po = poMap.get(doc.purchaseOrderId.toHexString());
      return {
        locationType: doc.locationKind === 'WAREHOUSE' ? 'Warehouse' : 'Division (direct)',
        location: name(
          refOf(doc.locationKind === 'WAREHOUSE' ? warehouses : divisions, doc.locationId),
        ),
        item: name(refOf(items, doc.itemId)),
        poNumber: po?.poNumber ?? null,
        poLineNo: po?.lines.find((l) => l._id.equals(doc.poLineId))?.lineNo ?? null,
        vendor: po ? name(refOf(vendors, po.vendorId)) : null,
        quantity: doc.quantity,
      };
    });
    return {
      columns: [
        text('locationType', 'Location type'),
        text('location', 'Location'),
        text('item', 'Item'),
        text('poNumber', 'PO number (lot)'),
        num('poLineNo', 'PO line'),
        text('vendor', 'Vendor'),
        num('quantity', 'On hand'),
      ],
      rows,
    };
  }

  private async dispatches(q: ReportQuery) {
    const filter: Filter<DispatchDoc> = { ...this.lifecycle(q), ...this.range('dispatchDate', q) };
    if (q.divisionId) filter.destinationDivisionId = new ObjectId(q.divisionId);
    if (q.itemId) filter['lines.itemId'] = new ObjectId(q.itemId);
    if (q.warehouseId)
      Object.assign(filter, { sourceKind: 'WAREHOUSE', sourceId: new ObjectId(q.warehouseId) });
    if (q.provinceId) {
      const divisions = await this.db
        .collection('divisions')
        .find({ provinceId: new ObjectId(q.provinceId) }, { projection: { _id: 1 } })
        .toArray();
      filter.destinationDivisionId = q.divisionId
        ? new ObjectId(q.divisionId)
        : { $in: divisions.map((d) => d._id) };
    }
    const docs = await this.db
      .collection<DispatchDoc>(DISPATCHES_COLLECTION)
      .find(filter)
      .sort({ dispatchDate: 1, code: 1 })
      .limit(REPORT_ROW_LIMIT + 1)
      .toArray();
    const [items, divisions, warehouses] = await Promise.all([
      fetchMasterMap(
        this.db,
        'items',
        docs.flatMap((d) => d.lines.map((l) => l.itemId.toHexString())),
      ),
      fetchMasterMap(
        this.db,
        'divisions',
        docs.flatMap((d) => [
          d.destinationDivisionId.toHexString(),
          ...(d.sourceKind === 'DIVISION' ? [d.sourceId.toHexString()] : []),
        ]),
      ),
      fetchMasterMap(
        this.db,
        'warehouses',
        docs.filter((d) => d.sourceKind === 'WAREHOUSE').map((d) => d.sourceId.toHexString()),
      ),
    ]);
    const provinces = await fetchMasterMap(
      this.db,
      'provinces',
      [...divisions.values()].flatMap((d) => (d.provinceId ? [d.provinceId.toHexString()] : [])),
    );
    const rows = docs.flatMap((doc) => {
      const destination = divisions.get(doc.destinationDivisionId.toHexString());
      return doc.lines
        .filter((line) => !q.itemId || line.itemId.equals(new ObjectId(q.itemId)))
        .map((line) => ({
          code: doc.code,
          dispatchDate: doc.dispatchDate,
          source: `${doc.sourceKind === 'WAREHOUSE' ? 'Warehouse' : 'Division (direct)'}: ${name(
            refOf(doc.sourceKind === 'WAREHOUSE' ? warehouses : divisions, doc.sourceId),
          )}`,
          destination: name(refOf(divisions, doc.destinationDivisionId)),
          province: destination?.provinceId
            ? (provinces.get(destination.provinceId.toHexString())?.name ?? null)
            : null,
          demand: doc.demandCode,
          biltyNo: doc.biltyNo,
          transporter: doc.transporterName,
          item: name(refOf(items, line.itemId)),
          poNumber: line.poNumber,
          quantity: line.quantity,
          status: doc.lifecycle.state === 'ACTIVE' ? 'Active' : 'Cancelled',
        }));
    });
    return {
      columns: [
        text('code', 'Dispatch'),
        text('dispatchDate', 'Date'),
        text('source', 'From'),
        text('destination', 'To division'),
        text('province', 'Province'),
        text('demand', 'Demand'),
        text('biltyNo', 'Bilty no'),
        text('transporter', 'Transporter'),
        text('item', 'Item'),
        text('poNumber', 'PO (lot)'),
        num('quantity', 'Quantity'),
        text('status', 'Status'),
      ],
      rows,
    };
  }

  private async payments(q: ReportQuery) {
    const filter: Filter<PaymentDoc> = { ...this.lifecycle(q), ...this.range('paymentDate', q) };
    if (q.vendorId) filter.vendorId = new ObjectId(q.vendorId);
    const docs = await this.db
      .collection<PaymentDoc>(PAYMENTS_COLLECTION)
      .find(filter)
      .sort({ paymentDate: 1, code: 1 })
      .limit(REPORT_ROW_LIMIT + 1)
      .toArray();
    const vendors = await fetchMasterMap(
      this.db,
      'vendors',
      docs.map((d) => d.vendorId.toHexString()),
    );
    const methods: Record<string, string> = {
      BANK_TRANSFER: 'Bank transfer',
      CHEQUE: 'Cheque',
      CASH: 'Cash',
      OTHER: 'Other',
    };
    const rows = docs.map((doc) => ({
      code: doc.code,
      paymentDate: doc.paymentDate,
      poNumber: doc.poNumber,
      vendor: name(refOf(vendors, doc.vendorId)),
      method: methods[doc.method] ?? doc.method,
      reference: doc.reference,
      scheduleEntryNo: doc.scheduleEntryNo,
      amount: doc.amount,
      status: doc.lifecycle.state === 'ACTIVE' ? 'Active' : 'Cancelled',
    }));
    return {
      columns: [
        text('code', 'Payment'),
        text('paymentDate', 'Date'),
        text('poNumber', 'PO number'),
        text('vendor', 'Vendor'),
        text('method', 'Method'),
        text('reference', 'Reference'),
        num('scheduleEntryNo', 'Instalment'),
        money('amount', 'Amount'),
        text('status', 'Status'),
      ],
      rows,
    };
  }

  private async demands(q: ReportQuery) {
    const filter: Filter<DemandDoc> = { ...this.lifecycle(q), ...this.range('demandDate', q) };
    if (q.provinceId) filter.provinceId = new ObjectId(q.provinceId);
    if (q.divisionId) filter['lines.destinationDivisionId'] = new ObjectId(q.divisionId);
    if (q.itemId) filter['lines.itemId'] = new ObjectId(q.itemId);
    const docs = await this.db
      .collection<DemandDoc>(DEMANDS_COLLECTION)
      .find(filter)
      .sort({ demandDate: 1, code: 1 })
      .limit(REPORT_ROW_LIMIT + 1)
      .toArray();
    const lines = docs.flatMap((d) => d.lines);
    const [departments, provinces, divisions, items, delivered] = await Promise.all([
      fetchMasterMap(
        this.db,
        'departments',
        docs.map((d) => d.departmentId.toHexString()),
      ),
      fetchMasterMap(
        this.db,
        'provinces',
        docs.map((d) => d.provinceId.toHexString()),
      ),
      fetchMasterMap(
        this.db,
        'divisions',
        lines.map((l) => l.destinationDivisionId.toHexString()),
      ),
      fetchMasterMap(
        this.db,
        'items',
        lines.map((l) => l.itemId.toHexString()),
      ),
      readTallies(
        this.db,
        lines.map((l) => tallyKey.dispatched(l._id)),
      ),
    ]);
    const rows = docs.flatMap((doc) =>
      doc.lines
        .filter(
          (line) =>
            (!q.itemId || line.itemId.equals(new ObjectId(q.itemId))) &&
            (!q.divisionId || line.destinationDivisionId.equals(new ObjectId(q.divisionId))),
        )
        .map((line) => {
          const done = delivered.get(tallyKey.dispatched(line._id)) ?? 0;
          return {
            code: doc.code,
            demandDate: doc.demandDate,
            department: name(refOf(departments, doc.departmentId)),
            province: name(refOf(provinces, doc.provinceId)),
            lineNo: line.lineNo,
            destination: name(refOf(divisions, line.destinationDivisionId)),
            item: name(refOf(items, line.itemId)),
            quantity: line.quantity,
            delivered: done,
            remaining: line.quantity - done,
            fulfilment: done === 0 ? 'PENDING' : done >= line.quantity ? 'DELIVERED' : 'PARTIAL',
            status: doc.lifecycle.state === 'ACTIVE' ? 'Open' : 'Cancelled',
          };
        }),
    );
    return {
      columns: [
        text('code', 'Demand'),
        text('demandDate', 'Date'),
        text('department', 'Department'),
        text('province', 'Province'),
        num('lineNo', 'Line'),
        text('destination', 'Destination division'),
        text('item', 'Item'),
        num('quantity', 'Requested'),
        num('delivered', 'Delivered'),
        num('remaining', 'Remaining'),
        text('fulfilment', 'Fulfilment'),
        text('status', 'Status'),
      ],
      rows,
    };
  }

  private async vendors(q: ReportQuery) {
    const docs = await this.poDocs(q);
    const [vendors, progressOf] = await Promise.all([
      fetchMasterMap(
        this.db,
        'vendors',
        docs.map((d) => d.vendorId.toHexString()),
      ),
      this.poProgress(docs),
    ]);
    const byVendor = new Map<
      string,
      {
        pos: number;
        ordered: number;
        received: number;
        approvedCents: number;
        paidCents: number;
        complete: number;
      }
    >();
    for (const doc of docs) {
      const key = doc.vendorId.toHexString();
      const p = progressOf(doc);
      const agg = byVendor.get(key) ?? {
        pos: 0,
        ordered: 0,
        received: 0,
        approvedCents: 0,
        paidCents: 0,
        complete: 0,
      };
      agg.pos += 1;
      agg.ordered += p.ordered;
      agg.received += p.received;
      agg.approvedCents += p.approvedCents;
      agg.paidCents += p.paidCents;
      if (p.completion === 'COMPLETE') agg.complete += 1;
      byVendor.set(key, agg);
    }
    const rows = [...byVendor.entries()]
      .map(([id, agg]) => ({
        vendor: name(refOf(vendors as RefDocs, new ObjectId(id))),
        pos: agg.pos,
        completePos: agg.complete,
        ordered: agg.ordered,
        received: agg.received,
        approved: agg.approvedCents / 100,
        paid: agg.paidCents / 100,
        outstanding: Math.max(0, agg.approvedCents - agg.paidCents) / 100,
      }))
      .sort((a, b) => a.vendor.localeCompare(b.vendor));
    return {
      columns: [
        text('vendor', 'Vendor'),
        num('pos', 'POs'),
        num('completePos', 'Complete POs'),
        num('ordered', 'Units ordered'),
        num('received', 'Units received'),
        money('approved', 'Approved'),
        money('paid', 'Paid'),
        money('outstanding', 'Outstanding'),
      ],
      rows,
    };
  }
}

function name(ref: MasterRef): string {
  return ref.code ? `${ref.name}` : ref.name;
}

/** RFC 4180 CSV with a guard against spreadsheet formula injection. */
export function toCsv(report: ReportResponse): string {
  const escape = (value: Cell | undefined): string => {
    if (value === null || value === undefined) return '';
    let textValue = typeof value === 'number' ? String(value) : value;
    if (typeof value === 'string' && /^[=+\-@\t\r]/.test(textValue)) textValue = `'${textValue}`;
    return /[",\r\n]/.test(textValue) ? `"${textValue.replace(/"/g, '""')}"` : textValue;
  };
  const lines = [report.columns.map((c) => escape(c.label)).join(',')];
  for (const row of report.rows) {
    lines.push(report.columns.map((c) => escape(row[c.key])).join(','));
  }
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
