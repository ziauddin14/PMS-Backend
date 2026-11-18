import { ObjectId, type Db, type IndexDescription } from 'mongodb';
import { z } from 'zod';
import type { MasterEntityKey } from '../contracts/api.js';
import { ensureCollection, recordCollectionSpec, type CollectionSpec } from '../db/collections.js';
import type { RecordDefinition, StoredRecord } from '../records/recordStore.js';

/** Fields that link a location record to its parent (province → division → district → city). */
export const masterParentFields = ['provinceId', 'divisionId', 'districtId', 'cityId'] as const;
export type MasterParentField = (typeof masterParentFields)[number];

/** Optional text fields that only some lists have. */
export const masterExtraFields = ['contactPerson', 'phone'] as const;
export type MasterExtraField = (typeof masterExtraFields)[number];

/** Stored fields of every master record (plus the M2 base fields from RecordStore). */
export interface MasterFields {
  name: string;
  /** Case- and space-insensitive form of the name, used for duplicate prevention. */
  nameKey: string;
  active: boolean;
  /** Divisions only. */
  provinceId?: ObjectId;
  /** Districts only. */
  divisionId?: ObjectId;
  /** Cities only. */
  districtId?: ObjectId;
  /** Receivers only. */
  cityId?: ObjectId;
  /** Vendors only: the person to contact at the vendor company. */
  contactPerson?: string | null;
  /** Receivers only: phone number (personal data). */
  phone?: string | null;
  [key: string]: unknown;
}
export type MasterRecordDoc = StoredRecord<MasterFields>;

export interface MasterEntityConfig {
  key: MasterEntityKey;
  /** Singular label used in messages. */
  label: string;
  collection: string;
  codePrefix: string;
  /** Location records belong to the level above them. */
  parent?: { field: MasterParentField; entity: MasterEntityKey; label: string };
  /** Child entities that must be deactivated before this record can be deactivated. */
  children?: Array<{ entity: MasterEntityKey; field: MasterParentField; label: string }>;
  /** Optional extra text fields of this list. */
  extraFields: MasterExtraField[];
  definition: RecordDefinition<MasterFields, Partial<MasterFields>>;
  spec: CollectionSpec;
}

/** Normalises a name for duplicate checks: trimmed, single spaces, lower case. */
export function nameKeyOf(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

const objectId = z.instanceof(ObjectId);

/** Index names per parent field. Divisions keep the names created in M4. */
const PARENT_INDEX_PREFIX: Record<MasterParentField, string> = {
  provinceId: 'province',
  divisionId: 'division',
  districtId: 'district',
  cityId: 'city',
};

function build(
  key: MasterEntityKey,
  label: string,
  codePrefix: string,
  extra: Pick<MasterEntityConfig, 'parent' | 'children'> & {
    extraFields?: MasterExtraField[];
  } = {},
): MasterEntityConfig {
  const parentField = extra.parent?.field;
  const extraFields = extra.extraFields ?? [];
  const shape: Record<string, z.ZodType> = {
    name: z.string().trim().min(1).max(100),
    nameKey: z.string().min(1).max(100),
    active: z.boolean(),
  };
  if (parentField) shape[parentField] = objectId;
  for (const field of extraFields) shape[field] = z.string().trim().max(100).nullable();

  const createSchema = z.object(shape).strict() as unknown as z.ZodType<MasterFields>;
  const updateSchema = z.object(shape).partial().strict() as unknown as z.ZodType<
    Partial<MasterFields>
  >;

  // Names are unique per entity, or per parent for location records.
  const prefix = parentField ? PARENT_INDEX_PREFIX[parentField] : '';
  const uniqueIndex: IndexDescription = parentField
    ? { key: { [parentField]: 1, nameKey: 1 }, name: `${prefix}_name_unique`, unique: true }
    : { key: { nameKey: 1 }, name: 'name_unique', unique: true };

  const spec = recordCollectionSpec(key, {
    required: parentField
      ? ['name', 'nameKey', 'active', parentField]
      : ['name', 'nameKey', 'active'],
    properties: {
      name: { bsonType: 'string', minLength: 1, maxLength: 100 },
      nameKey: { bsonType: 'string', minLength: 1, maxLength: 100 },
      active: { bsonType: 'bool' },
      ...(parentField ? { [parentField]: { bsonType: 'objectId' } } : {}),
      ...Object.fromEntries(
        extraFields.map((field) => [field, { bsonType: ['string', 'null'], maxLength: 100 }]),
      ),
    },
    indexes: [
      uniqueIndex,
      { key: { active: 1, nameKey: 1 }, name: 'active_name' },
      ...(parentField ? [{ key: { [parentField]: 1, active: 1 }, name: `${prefix}_active` }] : []),
    ],
  });

  return {
    key,
    label,
    collection: key,
    codePrefix,
    parent: extra.parent,
    children: extra.children,
    extraFields,
    definition: { collection: key, codePrefix, createSchema, updateSchema },
    spec,
  };
}

export const MASTER_ENTITIES: Record<MasterEntityKey, MasterEntityConfig> = {
  provinces: build('provinces', 'Province', 'PRV', {
    children: [{ entity: 'divisions', field: 'provinceId', label: 'division' }],
  }),
  divisions: build('divisions', 'Division', 'DIV', {
    parent: { field: 'provinceId', entity: 'provinces', label: 'Province' },
    children: [{ entity: 'districts', field: 'divisionId', label: 'district' }],
  }),
  districts: build('districts', 'District', 'DST', {
    parent: { field: 'divisionId', entity: 'divisions', label: 'Division' },
    children: [{ entity: 'cities', field: 'districtId', label: 'city' }],
  }),
  cities: build('cities', 'City', 'CTY', {
    parent: { field: 'districtId', entity: 'districts', label: 'District' },
    children: [{ entity: 'receivers', field: 'cityId', label: 'receiver' }],
  }),
  departments: build('departments', 'Department', 'DEP'),
  items: build('items', 'Item', 'ITM'),
  vendors: build('vendors', 'Vendor', 'VEN', { extraFields: ['contactPerson'] }),
  warehouses: build('warehouses', 'Warehouse', 'WHS'),
  /** Division receivers (name and phone) per city, used to fill demand lines. */
  receivers: build('receivers', 'Receiver', 'RCV', {
    parent: { field: 'cityId', entity: 'cities', label: 'City' },
    extraFields: ['phone'],
  }),
};

/** Lists that contain personal data (Q-30): only the Production Operator may read them. */
export const PERSONAL_DATA_ENTITIES: readonly MasterEntityKey[] = ['receivers'];

export async function ensureMasterDataCollections(db: Db): Promise<void> {
  for (const config of Object.values(MASTER_ENTITIES)) await ensureCollection(db, config.spec);
}
