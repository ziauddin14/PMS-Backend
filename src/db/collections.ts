import type { Db, Document, IndexDescription } from 'mongodb';

/** Infrastructure collections created in M2. Business collections arrive with their milestones. */
export const COLLECTIONS = {
  counters: 'counters',
  auditEvents: 'auditEvents',
  syncJobs: 'syncJobs',
  importBatches: 'importBatches',
  rawSourceRows: 'rawSourceRows',
} as const;

const intType = { bsonType: ['int', 'long'] };
const actorJsonSchema = {
  bsonType: 'object',
  required: ['type'],
  properties: {
    type: { enum: ['USER', 'EXCEL_SYNC', 'IMPORT', 'SYSTEM'] },
    id: { bsonType: 'string' },
    label: { bsonType: 'string' },
  },
};
const entityRefJsonSchema = {
  bsonType: 'object',
  required: ['collection', 'id', 'code'],
  properties: {
    collection: { bsonType: 'string' },
    id: { bsonType: 'objectId' },
    code: { bsonType: 'string' },
  },
};

/** Fields every operational record carries. Business-specific fields are added per collection. */
export const baseRecordJsonSchemaProperties: Document = {
  _id: { bsonType: 'objectId' },
  code: { bsonType: 'string', pattern: '^[A-Z][A-Z0-9]{1,7}-[0-9]{6,}$' },
  rev: { bsonType: ['int', 'long'], minimum: 1 },
  createdAt: { bsonType: 'date' },
  updatedAt: { bsonType: 'date' },
  createdBy: actorJsonSchema,
  updatedBy: actorJsonSchema,
  lifecycle: {
    bsonType: 'object',
    required: ['state'],
    properties: {
      state: { enum: ['ACTIVE', 'ARCHIVED'] },
      archivedAt: { bsonType: ['date', 'null'] },
      archivedBy: { bsonType: ['object', 'null'] },
      archiveReason: { bsonType: ['string', 'null'] },
    },
  },
  provenance: { bsonType: 'object' },
};
export const baseRecordRequired = [
  'code',
  'rev',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'lifecycle',
];

export const baseRecordIndexes: IndexDescription[] = [
  { key: { code: 1 }, name: 'code_unique', unique: true },
  { key: { 'lifecycle.state': 1, updatedAt: -1 }, name: 'lifecycle_updatedAt' },
  {
    key: { 'provenance.importBatchId': 1 },
    name: 'provenance_importBatch',
    partialFilterExpression: { 'provenance.importBatchId': { $exists: true } },
  },
];

export interface CollectionSpec {
  name: string;
  validator: Document;
  indexes: IndexDescription[];
}

export const infrastructureCollections: CollectionSpec[] = [
  {
    name: COLLECTIONS.counters,
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['_id', 'seq'],
        properties: { _id: { bsonType: 'string' }, seq: { ...intType, minimum: 0 } },
      },
    },
    indexes: [],
  },
  {
    name: COLLECTIONS.auditEvents,
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          'occurredAt',
          'actor',
          'action',
          'entity',
          'revAfter',
          'changes',
          'state',
          'atomic',
        ],
        properties: {
          occurredAt: { bsonType: 'date' },
          actor: actorJsonSchema,
          action: { enum: ['CREATE', 'UPDATE', 'ARCHIVE'] },
          entity: entityRefJsonSchema,
          revBefore: { bsonType: ['int', 'long', 'null'] },
          revAfter: intType,
          changes: {
            bsonType: 'array',
            items: {
              bsonType: 'object',
              required: ['field'],
              properties: { field: { bsonType: 'string' } },
            },
          },
          state: { enum: ['COMMITTED', 'PENDING', 'FAILED'] },
          atomic: { bsonType: 'bool' },
          failureReason: { bsonType: ['string', 'null'] },
          correlationId: { bsonType: ['string', 'null'] },
          requestId: { bsonType: ['string', 'null'] },
          provenance: { bsonType: ['object', 'null'] },
        },
      },
    },
    indexes: [
      { key: { 'entity.collection': 1, 'entity.id': 1, occurredAt: 1 }, name: 'entity_history' },
      { key: { occurredAt: -1 }, name: 'occurredAt' },
      { key: { state: 1, occurredAt: 1 }, name: 'state_occurredAt' },
      { key: { correlationId: 1 }, name: 'correlationId', sparse: true },
    ],
  },
  {
    name: COLLECTIONS.syncJobs,
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [
          'idempotencyKey',
          'direction',
          'target',
          'entity',
          'entityRev',
          'operation',
          'status',
          'attempts',
          'nextAttemptAt',
          'createdAt',
          'updatedAt',
        ],
        properties: {
          idempotencyKey: { bsonType: 'string', minLength: 1 },
          direction: { enum: ['OUTBOUND', 'INBOUND'] },
          target: {
            bsonType: 'object',
            required: ['workbook'],
            properties: { workbook: { bsonType: 'string' }, sheet: { bsonType: 'string' } },
          },
          entity: entityRefJsonSchema,
          entityRev: intType,
          operation: { enum: ['CREATE', 'UPDATE', 'ARCHIVE'] },
          changedFields: { bsonType: 'array', items: { bsonType: 'string' } },
          status: { enum: ['PENDING', 'LEASED', 'DONE', 'RETRY', 'CONFLICT', 'FAILED'] },
          attempts: { ...intType, minimum: 0 },
          nextAttemptAt: { bsonType: 'date' },
          lease: { bsonType: ['object', 'null'] },
          lastError: { bsonType: ['string', 'null'] },
          createdAt: { bsonType: 'date' },
          updatedAt: { bsonType: 'date' },
        },
      },
    },
    indexes: [
      { key: { idempotencyKey: 1 }, name: 'idempotencyKey_unique', unique: true },
      { key: { status: 1, nextAttemptAt: 1 }, name: 'status_nextAttempt' },
      { key: { 'target.workbook': 1, status: 1, createdAt: 1 }, name: 'workbook_queue' },
      { key: { 'entity.collection': 1, 'entity.id': 1 }, name: 'entity' },
    ],
  },
  {
    name: COLLECTIONS.importBatches,
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['code', 'label', 'status', 'sourceFiles', 'createdAt', 'createdBy'],
        properties: {
          code: { bsonType: 'string' },
          label: { bsonType: 'string' },
          status: { enum: ['DRAFT', 'STAGED', 'ASSESSED', 'IN_REVIEW', 'ACCEPTED', 'REJECTED'] },
          sourceFiles: {
            bsonType: 'array',
            items: {
              bsonType: 'object',
              required: ['fileName', 'sha256'],
              properties: {
                fileName: { bsonType: 'string' },
                sha256: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
                sizeBytes: intType,
              },
            },
          },
          createdAt: { bsonType: 'date' },
          createdBy: actorJsonSchema,
        },
      },
    },
    indexes: [
      { key: { code: 1 }, name: 'code_unique', unique: true },
      { key: { createdAt: -1 }, name: 'createdAt' },
    ],
  },
  {
    // Raw historical rows exactly as found in a source workbook. Kept separate from verified
    // operational records; mapping into business records happens in a later, reviewed step.
    name: COLLECTIONS.rawSourceRows,
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: ['importBatchId', 'source', 'cells', 'containsPersonalData', 'capturedAt'],
        properties: {
          importBatchId: { bsonType: 'objectId' },
          source: {
            bsonType: 'object',
            required: ['fileName', 'fileSha256', 'sheet', 'rowNumber'],
            properties: {
              fileName: { bsonType: 'string' },
              fileSha256: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
              sheet: { bsonType: 'string' },
              rowNumber: { ...intType, minimum: 1 },
            },
          },
          cells: {
            bsonType: 'array',
            items: {
              bsonType: 'object',
              required: ['ref'],
              properties: {
                ref: { bsonType: 'string', pattern: '^[A-Z]{1,3}[0-9]+$' },
                formula: { bsonType: ['string', 'null'] },
              },
            },
          },
          containsPersonalData: { bsonType: 'bool' },
          capturedAt: { bsonType: 'date' },
        },
      },
    },
    indexes: [
      {
        key: { 'source.fileSha256': 1, 'source.sheet': 1, 'source.rowNumber': 1 },
        name: 'source_row_unique',
        unique: true,
      },
      { key: { importBatchId: 1 }, name: 'importBatch' },
    ],
  },
];

/** Creates missing collections, (re)applies validators and creates indexes. Safe to run repeatedly. */
export async function ensureCollection(db: Db, spec: CollectionSpec): Promise<void> {
  const existing = await db.listCollections({ name: spec.name }, { nameOnly: true }).toArray();
  if (existing.length === 0) {
    await db.createCollection(spec.name, {
      validator: spec.validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  } else {
    await db.command({
      collMod: spec.name,
      validator: spec.validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
  }
  if (spec.indexes.length > 0) {
    await db.collection(spec.name).createIndexes(spec.indexes);
  }
}

export async function ensureInfrastructureCollections(db: Db): Promise<void> {
  for (const spec of infrastructureCollections) {
    await ensureCollection(db, spec);
  }
}

/** Builds the collection spec for an operational record collection (base fields + extras). */
export function recordCollectionSpec(
  name: string,
  extra: { properties?: Document; required?: string[]; indexes?: IndexDescription[] } = {},
): CollectionSpec {
  return {
    name,
    validator: {
      $jsonSchema: {
        bsonType: 'object',
        required: [...baseRecordRequired, ...(extra.required ?? [])],
        properties: { ...baseRecordJsonSchemaProperties, ...(extra.properties ?? {}) },
      },
    },
    indexes: [...baseRecordIndexes, ...(extra.indexes ?? [])],
  };
}
