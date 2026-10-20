import { ObjectId, type Db } from 'mongodb';
import { z } from 'zod';
import { ensureCollection, recordCollectionSpec } from '../db/collections.js';
import type { RecordDefinition, StoredRecord } from '../records/recordStore.js';

export const DEMANDS_COLLECTION = 'demands';

export interface StoredDemandLine {
  /** Stable line identity; dispatch lines (M8) will reference it. */
  _id: ObjectId;
  /** 1, 2, 3 … within the demand; never reused, even after a line is removed. */
  lineNo: number;
  itemId: ObjectId;
  destinationDivisionId: ObjectId;
  quantity: number;
  receiverName: string | null;
  receiverPhone: string | null;
}

export interface DemandFields {
  /** Business date the demand was received, YYYY-MM-DD (Asia/Karachi). */
  demandDate: string;
  departmentId: ObjectId;
  provinceId: ObjectId;
  divisionId: ObjectId | null;
  /** E-mail subject or other source reference; not unique (02 §2.1). */
  sourceReference: string | null;
  /** Lower-case, space-normalised source reference, used only for search. */
  searchText: string;
  nextLineNo: number;
  lines: StoredDemandLine[];
  [key: string]: unknown;
}
export type DemandDoc = StoredRecord<DemandFields>;

const objectId = z.instanceof(ObjectId);

const lineSchema = z
  .object({
    _id: objectId,
    lineNo: z.number().int().min(1),
    itemId: objectId,
    destinationDivisionId: objectId,
    quantity: z.number().int().min(1),
    receiverName: z.string().nullable(),
    receiverPhone: z.string().nullable(),
  })
  .strict();

const fieldsSchema = z
  .object({
    demandDate: z.string(),
    departmentId: objectId,
    provinceId: objectId,
    divisionId: objectId.nullable(),
    sourceReference: z.string().nullable(),
    searchText: z.string(),
    nextLineNo: z.number().int().min(1),
    lines: z.array(lineSchema).min(1),
  })
  .strict();

/**
 * Demands are records in the M2 RecordStore: permanent id, immutable Demand Number (code),
 * revision, audit trail, cancellation by archive (with reason), and outbound sync jobs for the
 * demand register. Sync jobs are only queued; they are processed in M10.
 */
export const demandDefinition: RecordDefinition<DemandFields, Partial<DemandFields>> = {
  collection: DEMANDS_COLLECTION,
  codePrefix: 'DMD',
  createSchema: fieldsSchema as unknown as z.ZodType<DemandFields>,
  updateSchema: fieldsSchema.partial() as unknown as z.ZodType<Partial<DemandFields>>,
  syncTargets: [{ workbook: 'DMD', sheet: 'demand sheet ' }],
};

const lineJsonSchema = {
  bsonType: 'object',
  required: ['_id', 'lineNo', 'itemId', 'destinationDivisionId', 'quantity'],
  properties: {
    _id: { bsonType: 'objectId' },
    lineNo: { bsonType: ['int', 'long'], minimum: 1 },
    itemId: { bsonType: 'objectId' },
    destinationDivisionId: { bsonType: 'objectId' },
    quantity: { bsonType: ['int', 'long', 'double'], minimum: 1 },
    receiverName: { bsonType: ['string', 'null'] },
    receiverPhone: { bsonType: ['string', 'null'] },
  },
};

export const demandsCollectionSpec = recordCollectionSpec(DEMANDS_COLLECTION, {
  required: ['demandDate', 'departmentId', 'provinceId', 'searchText', 'nextLineNo', 'lines'],
  properties: {
    demandDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    departmentId: { bsonType: 'objectId' },
    provinceId: { bsonType: 'objectId' },
    divisionId: { bsonType: ['objectId', 'null'] },
    sourceReference: { bsonType: ['string', 'null'], maxLength: 200 },
    searchText: { bsonType: 'string' },
    nextLineNo: { bsonType: ['int', 'long'], minimum: 1 },
    lines: { bsonType: 'array', minItems: 1, maxItems: 200, items: lineJsonSchema },
  },
  indexes: [
    { key: { 'lifecycle.state': 1, demandDate: -1, code: -1 }, name: 'state_date' },
    { key: { departmentId: 1, demandDate: -1 }, name: 'department_date' },
    { key: { provinceId: 1, demandDate: -1 }, name: 'province_date' },
    { key: { 'lines.itemId': 1 }, name: 'line_item' },
    { key: { 'lines.destinationDivisionId': 1 }, name: 'line_destination' },
  ],
});

export async function ensureDemandCollections(db: Db): Promise<void> {
  await ensureCollection(db, demandsCollectionSpec);
}
