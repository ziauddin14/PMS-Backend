import { ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import { ensureCollection, recordCollectionSpec } from '../db/collections.js';
import type { RecordDefinition, StoredRecord } from '../records/recordStore.js';

export const RECEIPTS_COLLECTION = 'receipts';

export interface StoredReceiptLine {
  _id: ObjectId;
  poLineId: ObjectId;
  poLineNo: number;
  itemId: ObjectId;
  quantity: number;
}

/** A vendor goods receipt against one PO (M7). Immutable once recorded; corrected by cancelling. */
export interface ReceiptFields {
  purchaseOrderId: ObjectId;
  purchaseOrderCode: string;
  poNumber: string;
  vendorId: ObjectId;
  deliveryRoute: 'WAREHOUSE' | 'DIRECT';
  /** WAREHOUSE route → the PO's target warehouse; DIRECT route → the destination division. */
  locationKind: 'WAREHOUSE' | 'DIVISION';
  locationId: ObjectId;
  receiptDate: string;
  vendorChallanNo: string | null;
  notes: string | null;
  /** Absent on receipts recorded before documents were added. */
  documents?: Array<{ label: string; url: string }>;
  lines: StoredReceiptLine[];
  totalQuantity: number;
  searchText: string;
  [key: string]: unknown;
}
export type ReceiptDoc = StoredRecord<ReceiptFields>;

const objectId = z.instanceof(ObjectId);
const fieldsSchema = z
  .object({
    purchaseOrderId: objectId,
    purchaseOrderCode: z.string(),
    poNumber: z.string(),
    vendorId: objectId,
    deliveryRoute: z.enum(['WAREHOUSE', 'DIRECT']),
    locationKind: z.enum(['WAREHOUSE', 'DIVISION']),
    locationId: objectId,
    receiptDate: z.string(),
    vendorChallanNo: z.string().nullable(),
    notes: z.string().nullable(),
    documents: z.array(z.object({ label: z.string(), url: z.string() }).strict()).max(20),
    lines: z
      .array(
        z
          .object({
            _id: objectId,
            poLineId: objectId,
            poLineNo: z.number().int().min(1),
            itemId: objectId,
            quantity: z.number().int().min(1),
          })
          .strict(),
      )
      .min(1),
    totalQuantity: z.number().int().min(1),
    searchText: z.string(),
  })
  .strict();

export const receiptDefinition: RecordDefinition<ReceiptFields, Partial<ReceiptFields>> = {
  collection: RECEIPTS_COLLECTION,
  codePrefix: 'GRN',
  createSchema: fieldsSchema as unknown as z.ZodType<ReceiptFields>,
  updateSchema: fieldsSchema.partial() as unknown as z.ZodType<Partial<ReceiptFields>>,
  syncTargets: [{ workbook: 'STOCK' }],
};

export const receiptsCollectionSpec = recordCollectionSpec(RECEIPTS_COLLECTION, {
  required: [
    'purchaseOrderId',
    'vendorId',
    'deliveryRoute',
    'locationKind',
    'locationId',
    'receiptDate',
    'lines',
    'totalQuantity',
    'searchText',
  ],
  properties: {
    purchaseOrderId: { bsonType: 'objectId' },
    vendorId: { bsonType: 'objectId' },
    deliveryRoute: { enum: ['WAREHOUSE', 'DIRECT'] },
    locationKind: { enum: ['WAREHOUSE', 'DIVISION'] },
    locationId: { bsonType: 'objectId' },
    receiptDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    vendorChallanNo: { bsonType: ['string', 'null'], maxLength: 50 },
    notes: { bsonType: ['string', 'null'], maxLength: 1000 },
    documents: { bsonType: 'array', maxItems: 20 },
    lines: { bsonType: 'array', minItems: 1, maxItems: 200 },
    totalQuantity: { bsonType: ['int', 'long', 'double'], minimum: 1 },
  },
  indexes: [
    { key: { 'lifecycle.state': 1, receiptDate: -1, code: -1 }, name: 'state_date' },
    { key: { purchaseOrderId: 1, receiptDate: -1 }, name: 'po_date' },
    { key: { vendorId: 1, receiptDate: -1 }, name: 'vendor_date' },
    { key: { 'lines.itemId': 1 }, name: 'line_item' },
  ],
});

export async function ensureReceiptCollections(db: Db): Promise<void> {
  await ensureCollection(db, receiptsCollectionSpec);
}
