import { ObjectId, type Db, type IndexDescription } from 'mongodb';
import { z } from 'zod';
import type { MasterEntityKey } from '../contracts/api.js';
import { ensureCollection, recordCollectionSpec, type CollectionSpec } from '../db/collections.js';
import type { RecordDefinition, StoredRecord } from '../records/recordStore.js';

/** Stored fields of every master record (plus the M2 base fields from RecordStore). */
export interface MasterFields {
  name: string;
  /** Case- and space-insensitive form of the name, used for duplicate prevention. */
  nameKey: string;
  active: boolean;
  /** Divisions only. */
  provinceId?: ObjectId;
  [key: string]: unknown;
}
export type MasterRecordDoc = StoredRecord<MasterFields>;

export interface MasterEntityConfig {
  key: MasterEntityKey;
  /** Singular label used in messages. */
  label: string;
  collection: string;
  codePrefix: string;
  /** Divisions belong to a province. */
  parent?: { field: 'provinceId'; entity: MasterEntityKey; label: string };
  /** Child entities that must be deactivated before this record can be deactivated. */
  children?: Array<{ entity: MasterEntityKey; field: 'provinceId'; label: string }>;
  definition: RecordDefinition<MasterFields, Partial<MasterFields>>;
  spec: CollectionSpec;
}

/** Normalises a name for duplicate checks: trimmed, single spaces, lower case. */
export function nameKeyOf(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

const objectId = z.instanceof(ObjectId);

function build(
  key: MasterEntityKey,
  label: string,
  codePrefix: string,
  extra: Pick<MasterEntityConfig, 'parent' | 'children'> = {},
): MasterEntityConfig {
  const withParent = Boolean(extra.parent);
  const base = {
    name: z.string().trim().min(1).max(100),
    nameKey: z.string().min(1).max(100),
    active: z.boolean(),
  };
  const createSchema = (withParent
    ? z.object({ ...base, provinceId: objectId })
    : z.object(base)
  ).strict() as unknown as z.ZodType<MasterFields>;
  const updateSchema = (withParent
    ? z.object({ ...base, provinceId: objectId }).partial()
    : z.object(base).partial()
  ).strict() as unknown as z.ZodType<Partial<MasterFields>>;

  // Names are unique per entity, or per province for divisions.
  const uniqueIndex: IndexDescription = withParent
    ? { key: { provinceId: 1, nameKey: 1 }, name: 'province_name_unique', unique: true }
    : { key: { nameKey: 1 }, name: 'name_unique', unique: true };

  const spec = recordCollectionSpec(key, {
    required: withParent
      ? ['name', 'nameKey', 'active', 'provinceId']
      : ['name', 'nameKey', 'active'],
    properties: {
      name: { bsonType: 'string', minLength: 1, maxLength: 100 },
      nameKey: { bsonType: 'string', minLength: 1, maxLength: 100 },
      active: { bsonType: 'bool' },
      ...(withParent ? { provinceId: { bsonType: 'objectId' } } : {}),
    },
    indexes: [
      uniqueIndex,
      { key: { active: 1, nameKey: 1 }, name: 'active_name' },
      ...(withParent ? [{ key: { provinceId: 1, active: 1 }, name: 'province_active' }] : []),
    ],
  });

  return {
    key,
    label,
    collection: key,
    codePrefix,
    ...extra,
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
  }),
  departments: build('departments', 'Department', 'DEP'),
  items: build('items', 'Item', 'ITM'),
  vendors: build('vendors', 'Vendor', 'VEN'),
  warehouses: build('warehouses', 'Warehouse', 'WHS'),
};

export async function ensureMasterDataCollections(db: Db): Promise<void> {
  for (const config of Object.values(MASTER_ENTITIES)) await ensureCollection(db, config.spec);
}
