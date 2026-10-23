import { ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import { ensureCollection, recordCollectionSpec } from '../db/collections.js';
import type { RecordDefinition, StoredRecord } from '../records/recordStore.js';

export const PURCHASE_ORDERS_COLLECTION = 'purchase_orders';

export interface StoredPaymentScheduleEntry {
  entryNo: number;
  dueDate: string;
  plannedAmount: number;
  note: string | null;
}

export interface StoredInvoice {
  invoiceNo: string | null;
  invoiceDate: string | null;
  invoiceAmount: number | null;
  notes: string | null;
}

export interface StoredPurchaseOrderLine {
  /** Stable line identity; receiving (M7) and dispatch (M8) will reference it. */
  _id: ObjectId;
  /** 1, 2, 3 … within the PO; never reused, even after a line is removed. */
  lineNo: number;
  itemId: ObjectId;
  demandId: ObjectId | null;
  demandLineId: ObjectId | null;
  quantityOrdered: number;
  unitPrice: number;
  lineTotal: number;
  notes: string | null;
}

export interface PurchaseOrderFields {
  /** Stable operational PO number (e.g. DIT/0189); unique across all POs (03 §3.2 P1). */
  poNumber: string;
  /** Lower-cased, trimmed PO number used for unique index collision checking. */
  poNumberNormalized: string;
  /** Business date of the PO, YYYY-MM-DD (Asia/Karachi). */
  poDate: string;
  vendorId: ObjectId;
  deliveryRoute: 'WAREHOUSE' | 'DIRECT';
  targetWarehouseId: ObjectId | null;
  destinationDivisionId: ObjectId | null;
  approvedAmount: number;
  totalAmount: number;
  expectedCompletionDate: string | null;
  notes: string | null;
  invoice: StoredInvoice | null;
  paymentSchedule: StoredPaymentScheduleEntry[];
  nextLineNo: number;
  lines: StoredPurchaseOrderLine[];
  /** Lower-case, space-normalised text for literal search. */
  searchText: string;
  [key: string]: unknown;
}
export type PurchaseOrderDoc = StoredRecord<PurchaseOrderFields>;

const objectId = z.instanceof(ObjectId);

const scheduleSchema = z
  .object({
    entryNo: z.number().int().min(1),
    dueDate: z.string(),
    plannedAmount: z.number().min(0),
    note: z.string().nullable(),
  })
  .strict();

const invoiceSchema = z
  .object({
    invoiceNo: z.string().nullable(),
    invoiceDate: z.string().nullable(),
    invoiceAmount: z.number().nullable(),
    notes: z.string().nullable(),
  })
  .strict();

const lineSchema = z
  .object({
    _id: objectId,
    lineNo: z.number().int().min(1),
    itemId: objectId,
    demandId: objectId.nullable(),
    demandLineId: objectId.nullable(),
    quantityOrdered: z.number().int().min(1),
    unitPrice: z.number().min(0),
    lineTotal: z.number().min(0),
    notes: z.string().nullable(),
  })
  .strict();

const fieldsSchema = z
  .object({
    poNumber: z.string().min(1),
    poNumberNormalized: z.string().min(1),
    poDate: z.string(),
    vendorId: objectId,
    deliveryRoute: z.enum(['WAREHOUSE', 'DIRECT']),
    targetWarehouseId: objectId.nullable(),
    destinationDivisionId: objectId.nullable(),
    approvedAmount: z.number().min(0),
    totalAmount: z.number().min(0),
    expectedCompletionDate: z.string().nullable(),
    notes: z.string().nullable(),
    invoice: invoiceSchema.nullable(),
    paymentSchedule: z.array(scheduleSchema),
    nextLineNo: z.number().int().min(1),
    lines: z.array(lineSchema).min(1),
    searchText: z.string(),
  })
  .strict();

/**
 * Purchase Orders in the M2 RecordStore: permanent id (PO-000001), revision,
 * audit trail, cancellation by archive (with reason), and outbound sync jobs for PRD PO.
 */
export const purchaseOrderDefinition: RecordDefinition<
  PurchaseOrderFields,
  Partial<PurchaseOrderFields>
> = {
  collection: PURCHASE_ORDERS_COLLECTION,
  codePrefix: 'PO',
  createSchema: fieldsSchema as unknown as z.ZodType<PurchaseOrderFields>,
  updateSchema: fieldsSchema.partial() as unknown as z.ZodType<Partial<PurchaseOrderFields>>,
  syncTargets: [{ workbook: 'PRD', sheet: 'PO' }],
};

const lineJsonSchema = {
  bsonType: 'object',
  required: ['_id', 'lineNo', 'itemId', 'quantityOrdered', 'unitPrice', 'lineTotal'],
  properties: {
    _id: { bsonType: 'objectId' },
    lineNo: { bsonType: ['int', 'long'], minimum: 1 },
    itemId: { bsonType: 'objectId' },
    demandId: { bsonType: ['objectId', 'null'] },
    demandLineId: { bsonType: ['objectId', 'null'] },
    quantityOrdered: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    unitPrice: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    lineTotal: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    notes: { bsonType: ['string', 'null'] },
  },
};

const scheduleJsonSchema = {
  bsonType: 'object',
  required: ['entryNo', 'dueDate', 'plannedAmount'],
  properties: {
    entryNo: { bsonType: ['int', 'long'], minimum: 1 },
    dueDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    plannedAmount: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    note: { bsonType: ['string', 'null'] },
  },
};

const invoiceJsonSchema = {
  bsonType: 'object',
  properties: {
    invoiceNo: { bsonType: ['string', 'null'] },
    invoiceDate: { bsonType: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    invoiceAmount: { bsonType: ['int', 'long', 'double', 'null'] },
    notes: { bsonType: ['string', 'null'] },
  },
};

export const purchaseOrdersCollectionSpec = recordCollectionSpec(PURCHASE_ORDERS_COLLECTION, {
  required: [
    'poNumber',
    'poNumberNormalized',
    'poDate',
    'vendorId',
    'deliveryRoute',
    'approvedAmount',
    'totalAmount',
    'paymentSchedule',
    'nextLineNo',
    'lines',
    'searchText',
  ],
  properties: {
    poNumber: { bsonType: 'string', maxLength: 50 },
    poNumberNormalized: { bsonType: 'string', maxLength: 50 },
    poDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    vendorId: { bsonType: 'objectId' },
    deliveryRoute: { enum: ['WAREHOUSE', 'DIRECT'] },
    targetWarehouseId: { bsonType: ['objectId', 'null'] },
    destinationDivisionId: { bsonType: ['objectId', 'null'] },
    approvedAmount: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    totalAmount: { bsonType: ['int', 'long', 'double'], minimum: 0 },
    expectedCompletionDate: { bsonType: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    notes: { bsonType: ['string', 'null'], maxLength: 1000 },
    invoice: { ...invoiceJsonSchema, bsonType: ['object', 'null'] },
    paymentSchedule: { bsonType: 'array', items: scheduleJsonSchema },
    nextLineNo: { bsonType: ['int', 'long'], minimum: 1 },
    lines: { bsonType: 'array', minItems: 1, maxItems: 200, items: lineJsonSchema },
    searchText: { bsonType: 'string' },
  },
  indexes: [
    { key: { poNumberNormalized: 1 }, name: 'poNumber_unique', unique: true },
    { key: { 'lifecycle.state': 1, poDate: -1, code: -1 }, name: 'state_date' },
    { key: { vendorId: 1, poDate: -1 }, name: 'vendor_date' },
    { key: { deliveryRoute: 1, poDate: -1 }, name: 'route_date' },
    { key: { 'lines.itemId': 1 }, name: 'line_item' },
    { key: { 'lines.demandId': 1 }, name: 'line_demand', sparse: true },
  ],
});

export async function ensurePurchaseOrderCollections(db: Db): Promise<void> {
  await ensureCollection(db, purchaseOrdersCollectionSpec);
}
