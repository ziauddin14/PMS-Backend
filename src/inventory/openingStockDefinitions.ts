import { ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import { ensureCollection, recordCollectionSpec } from '../db/collections.js';
import type { RecordDefinition, StoredRecord } from '../records/recordStore.js';

export const OPENING_STOCK_COLLECTION = 'opening_stock';

export interface StoredOpeningStockLine {
  _id: ObjectId;
  lineNo: number;
  itemId: ObjectId;
  quantity: number;
}

/**
 * Opening stock: goods that were already in a warehouse when PMS started, or arrived without a
 * PMS purchase order (CD-13 special non-PO lots). Each line becomes its own stock lot. Immutable
 * once recorded; corrected by cancelling (only while none of its stock has been dispatched).
 */
export interface OpeningStockFields {
  warehouseId: ObjectId;
  entryDate: string;
  reference: string | null;
  notes: string | null;
  lines: StoredOpeningStockLine[];
  totalQuantity: number;
  searchText: string;
  [key: string]: unknown;
}
export type OpeningStockDoc = StoredRecord<OpeningStockFields>;

const objectId = z.instanceof(ObjectId);
const fieldsSchema = z
  .object({
    warehouseId: objectId,
    entryDate: z.string(),
    reference: z.string().nullable(),
    notes: z.string().nullable(),
    lines: z
      .array(
        z
          .object({
            _id: objectId,
            lineNo: z.number().int().min(1),
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

export const openingStockDefinition: RecordDefinition<
  OpeningStockFields,
  Partial<OpeningStockFields>
> = {
  collection: OPENING_STOCK_COLLECTION,
  codePrefix: 'OPN',
  createSchema: fieldsSchema as unknown as z.ZodType<OpeningStockFields>,
  updateSchema: fieldsSchema.partial() as unknown as z.ZodType<Partial<OpeningStockFields>>,
  syncTargets: [{ workbook: 'STOCK' }],
};

export const openingStockCollectionSpec = recordCollectionSpec(OPENING_STOCK_COLLECTION, {
  required: ['warehouseId', 'entryDate', 'lines', 'totalQuantity', 'searchText'],
  properties: {
    warehouseId: { bsonType: 'objectId' },
    entryDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    reference: { bsonType: ['string', 'null'], maxLength: 100 },
    notes: { bsonType: ['string', 'null'], maxLength: 1000 },
    lines: { bsonType: 'array', minItems: 1, maxItems: 200 },
    totalQuantity: { bsonType: ['int', 'long', 'double'], minimum: 1 },
  },
  indexes: [
    { key: { 'lifecycle.state': 1, entryDate: -1, code: -1 }, name: 'state_date' },
    { key: { warehouseId: 1, entryDate: -1 }, name: 'warehouse_date' },
    { key: { 'lines._id': 1 }, name: 'line_id' },
    { key: { 'lines.itemId': 1 }, name: 'line_item' },
  ],
});

export async function ensureOpeningStockCollections(db: Db): Promise<void> {
  await ensureCollection(db, openingStockCollectionSpec);
}
