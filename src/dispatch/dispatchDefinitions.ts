import { ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import { ensureCollection, recordCollectionSpec } from '../db/collections.js';
import type { RecordDefinition, StoredRecord } from '../records/recordStore.js';

export const DISPATCHES_COLLECTION = 'dispatches';

export interface StoredDispatchLine {
  _id: ObjectId;
  lineNo: number;
  itemId: ObjectId;
  /** Stock lot = PO line the goods were received against. */
  purchaseOrderId: ObjectId;
  purchaseOrderCode: string;
  poNumber: string;
  poLineId: ObjectId;
  poLineNo: number;
  quantity: number;
  demandLineId: ObjectId | null;
  demandLineNo: number | null;
}

export interface StoredDocumentRef {
  label: string;
  url: string;
}

/** A dispatch (with Bilty / transport details) from a stock location to a division (M8). */
export interface DispatchFields {
  dispatchDate: string;
  sourceKind: 'WAREHOUSE' | 'DIVISION';
  sourceId: ObjectId;
  destinationDivisionId: ObjectId;
  demandId: ObjectId | null;
  demandCode: string | null;
  biltyNo: string | null;
  transporterName: string | null;
  vehicleNo: string | null;
  freightAmount: number | null;
  notes: string | null;
  documents: StoredDocumentRef[];
  lines: StoredDispatchLine[];
  totalQuantity: number;
  searchText: string;
  [key: string]: unknown;
}
export type DispatchDoc = StoredRecord<DispatchFields>;

const objectId = z.instanceof(ObjectId);
const documentSchema = z.object({ label: z.string(), url: z.string() }).strict();
const fieldsSchema = z
  .object({
    dispatchDate: z.string(),
    sourceKind: z.enum(['WAREHOUSE', 'DIVISION']),
    sourceId: objectId,
    destinationDivisionId: objectId,
    demandId: objectId.nullable(),
    demandCode: z.string().nullable(),
    biltyNo: z.string().nullable(),
    transporterName: z.string().nullable(),
    vehicleNo: z.string().nullable(),
    freightAmount: z.number().min(0).nullable(),
    notes: z.string().nullable(),
    documents: z.array(documentSchema),
    lines: z
      .array(
        z
          .object({
            _id: objectId,
            lineNo: z.number().int().min(1),
            itemId: objectId,
            purchaseOrderId: objectId,
            purchaseOrderCode: z.string(),
            poNumber: z.string(),
            poLineId: objectId,
            poLineNo: z.number().int(),
            quantity: z.number().int().min(1),
            demandLineId: objectId.nullable(),
            demandLineNo: z.number().int().nullable(),
          })
          .strict(),
      )
      .min(1),
    totalQuantity: z.number().int().min(1),
    searchText: z.string(),
  })
  .strict();

export const dispatchDefinition: RecordDefinition<DispatchFields, Partial<DispatchFields>> = {
  collection: DISPATCHES_COLLECTION,
  codePrefix: 'DSP',
  createSchema: fieldsSchema as unknown as z.ZodType<DispatchFields>,
  updateSchema: fieldsSchema.partial() as unknown as z.ZodType<Partial<DispatchFields>>,
  // Legacy PO!J "Delivered" is dispatch to divisions; the demand register tracks fulfilment.
  syncTargets: [
    { workbook: 'PRD', sheet: 'PO' },
    { workbook: 'DMD', sheet: 'demand sheet ' },
  ],
};

export const dispatchesCollectionSpec = recordCollectionSpec(DISPATCHES_COLLECTION, {
  required: [
    'dispatchDate',
    'sourceKind',
    'sourceId',
    'destinationDivisionId',
    'documents',
    'lines',
    'totalQuantity',
    'searchText',
  ],
  properties: {
    dispatchDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    sourceKind: { enum: ['WAREHOUSE', 'DIVISION'] },
    sourceId: { bsonType: 'objectId' },
    destinationDivisionId: { bsonType: 'objectId' },
    demandId: { bsonType: ['objectId', 'null'] },
    biltyNo: { bsonType: ['string', 'null'], maxLength: 50 },
    transporterName: { bsonType: ['string', 'null'], maxLength: 100 },
    vehicleNo: { bsonType: ['string', 'null'], maxLength: 30 },
    freightAmount: { bsonType: ['int', 'long', 'double', 'null'], minimum: 0 },
    notes: { bsonType: ['string', 'null'], maxLength: 1000 },
    documents: { bsonType: 'array', maxItems: 20 },
    lines: { bsonType: 'array', minItems: 1, maxItems: 200 },
    totalQuantity: { bsonType: ['int', 'long', 'double'], minimum: 1 },
  },
  indexes: [
    { key: { 'lifecycle.state': 1, dispatchDate: -1, code: -1 }, name: 'state_date' },
    { key: { destinationDivisionId: 1, dispatchDate: -1 }, name: 'destination_date' },
    { key: { sourceKind: 1, sourceId: 1, dispatchDate: -1 }, name: 'source_date' },
    { key: { demandId: 1 }, name: 'demand', sparse: true },
    { key: { 'lines.purchaseOrderId': 1 }, name: 'line_po' },
    { key: { 'lines.itemId': 1 }, name: 'line_item' },
  ],
});

export async function ensureDispatchCollections(db: Db): Promise<void> {
  await ensureCollection(db, dispatchesCollectionSpec);
}
