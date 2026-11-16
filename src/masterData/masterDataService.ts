import { MongoServerError, ObjectId, type Collection, type Filter } from 'mongodb';
import type {
  MasterCreateInput,
  MasterEntityKey,
  MasterListQuery,
  MasterListResponse,
  MasterRecord,
  MasterUpdateInput,
} from '../contracts/api.js';
import type { Database } from '../db/mongo.js';
import type { MutationContext } from '../domain/context.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import type { RecordStore } from '../records/recordStore.js';
import {
  MASTER_ENTITIES,
  masterExtraFields,
  masterParentFields,
  nameKeyOf,
  type MasterEntityConfig,
  type MasterFields,
  type MasterParentField,
  type MasterRecordDoc,
} from './definitions.js';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

/** Collapses inner spaces; an empty value is stored as null. */
function cleanText(value: string): string | null {
  const cleaned = value.trim().replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned : null;
}

/** `provinceId` → `province`, used to name the DTO fields of each ancestor level. */
function levelOf(field: MasterParentField): 'province' | 'division' | 'district' {
  return field.slice(0, -2) as 'province' | 'division' | 'district';
}

/**
 * Master-data operations. All writes go through the M2 RecordStore (validation, codes,
 * optimistic concurrency, audit). Records are activated/deactivated, never deleted, so historical
 * references stay valid. Location records form a chain: province → division → district → city.
 */
export class MasterDataService {
  constructor(
    private readonly database: Database,
    private readonly store: RecordStore,
  ) {}

  private config(entity: MasterEntityKey): MasterEntityConfig {
    return MASTER_ENTITIES[entity];
  }

  private collection(entity: MasterEntityKey): Collection<MasterRecordDoc> {
    return this.database.db.collection<MasterRecordDoc>(this.config(entity).collection);
  }

  async list(entity: MasterEntityKey, query: MasterListQuery): Promise<MasterListResponse> {
    const config = this.config(entity);
    const filter: Filter<MasterRecordDoc> = {};
    for (const field of masterParentFields) {
      const value = query[field];
      if (value === undefined) continue;
      if (config.parent?.field !== field) {
        throw new ValidationError([{ path: field, message: 'Not a filter for this list' }]);
      }
      filter[field] = new ObjectId(value);
    }
    if (query.status !== 'all') filter.active = query.status === 'active';
    if (query.search) filter.nameKey = { $regex: escapeRegex(nameKeyOf(query.search)) };

    const collection = this.collection(entity);
    const [docs, total] = await Promise.all([
      collection
        .find(filter)
        .sort({ nameKey: 1, _id: 1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .toArray(),
      collection.countDocuments(filter),
    ]);
    return {
      items: await this.toDtos(config, docs),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async get(entity: MasterEntityKey, id: string): Promise<MasterRecord> {
    const config = this.config(entity);
    const doc = await this.findOrThrow(config, id);
    return (await this.toDtos(config, [doc]))[0] as MasterRecord;
  }

  /** Finds an existing record by name (and parent), for idempotent imports. */
  async findByName(
    entity: MasterEntityKey,
    name: string,
    parentId?: string,
  ): Promise<MasterRecord | null> {
    const config = this.config(entity);
    const filter: Filter<MasterRecordDoc> = { nameKey: nameKeyOf(name) };
    if (config.parent) {
      if (!parentId) throw new Error(`${config.label} lookup needs a parent id`);
      filter[config.parent.field] = new ObjectId(parentId);
    }
    const doc = await this.collection(entity).findOne(filter);
    return doc ? ((await this.toDtos(config, [doc]))[0] as MasterRecord) : null;
  }

  async create(
    entity: MasterEntityKey,
    input: MasterCreateInput,
    ctx: MutationContext,
  ): Promise<MasterRecord> {
    const config = this.config(entity);
    this.rejectForeignFields(config, input);
    const data: MasterFields = {
      name: input.name.replace(/\s+/g, ' '),
      nameKey: nameKeyOf(input.name),
      active: true,
    };
    if (config.parent) {
      const parentId = input[config.parent.field];
      if (!parentId) {
        throw new ValidationError([
          { path: config.parent.field, message: `${config.parent.label} is required` },
        ]);
      }
      data[config.parent.field] = await this.requireActiveParent(config, parentId);
    }
    for (const field of config.extraFields) data[field] = cleanText(input[field] ?? '');

    await this.assertNameFree(config, data.nameKey, this.parentIdOf(config, data));
    try {
      const doc = (await this.store.create(config.definition, data, ctx)) as MasterRecordDoc;
      return (await this.toDtos(config, [doc]))[0] as MasterRecord;
    } catch (error) {
      if (isDuplicateKey(error)) throw this.duplicate(config);
      throw error;
    }
  }

  async update(
    entity: MasterEntityKey,
    id: string,
    input: MasterUpdateInput,
    ctx: MutationContext,
  ): Promise<MasterRecord> {
    const config = this.config(entity);
    this.rejectForeignFields(config, input);
    const current = await this.findOrThrow(config, id);
    const changes: Partial<MasterFields> = {};
    const parentField = config.parent?.field;

    if (input.name !== undefined) {
      changes.name = input.name.replace(/\s+/g, ' ');
      changes.nameKey = nameKeyOf(input.name);
    }
    if (parentField) {
      const requested = input[parentField];
      if (requested !== undefined && requested !== current[parentField]?.toHexString()) {
        changes[parentField] = await this.requireActiveParent(config, requested);
      }
    }
    for (const field of config.extraFields) {
      const value = input[field];
      if (value !== undefined && cleanText(value) !== (current[field] ?? null)) {
        changes[field] = cleanText(value);
      }
    }
    if (input.active !== undefined) {
      changes.active = input.active;
      const currentParent = parentField ? current[parentField] : undefined;
      if (input.active && parentField && currentParent && changes[parentField] === undefined) {
        await this.requireActiveParent(config, currentParent.toHexString());
      }
      if (!input.active && current.active) await this.assertNoActiveChildren(config, current._id);
    }

    if (Object.keys(changes).length === 0) {
      if (input.rev !== current.rev) {
        throw new ConflictError(
          `Record was changed by someone else (expected revision ${input.rev}); reload and try again`,
        );
      }
      return (await this.toDtos(config, [current]))[0] as MasterRecord;
    }

    const nameKey = changes.nameKey ?? current.nameKey;
    const parentId = this.parentIdOf(config, changes) ?? this.parentIdOf(config, current);
    if (changes.nameKey !== undefined || (parentField && changes[parentField] !== undefined)) {
      await this.assertNameFree(config, nameKey, parentId, current._id);
    }

    try {
      const updated = (await this.store.update(
        config.definition,
        current._id,
        input.rev,
        changes,
        ctx,
      )) as MasterRecordDoc;
      return (await this.toDtos(config, [updated]))[0] as MasterRecord;
    } catch (error) {
      if (isDuplicateKey(error)) throw this.duplicate(config);
      throw error;
    }
  }

  /** Parent ids and extra fields are only accepted by the lists that have them. */
  private rejectForeignFields(
    config: MasterEntityConfig,
    input: Partial<Record<string, unknown>>,
  ): void {
    const details = [
      ...masterParentFields.filter((f) => f !== config.parent?.field),
      ...masterExtraFields.filter((f) => !config.extraFields.includes(f)),
    ]
      .filter((field) => input[field] !== undefined)
      .map((field) => ({ path: field, message: 'Not a field of this record' }));
    if (details.length > 0) throw new ValidationError(details);
  }

  private parentIdOf(config: MasterEntityConfig, doc: Partial<MasterFields>): ObjectId | undefined {
    return config.parent ? (doc[config.parent.field] as ObjectId | undefined) : undefined;
  }

  private async findOrThrow(config: MasterEntityConfig, id: string): Promise<MasterRecordDoc> {
    const doc = /^[a-f0-9]{24}$/.test(id)
      ? await this.collection(config.key).findOne({ _id: new ObjectId(id) })
      : null;
    if (!doc) throw new NotFoundError(`${config.label} not found`);
    return doc;
  }

  private async requireActiveParent(config: MasterEntityConfig, id: string): Promise<ObjectId> {
    const parent = config.parent;
    if (!parent) throw new Error('Entity has no parent');
    const doc = await this.collection(parent.entity).findOne({ _id: new ObjectId(id) });
    if (!doc) {
      throw new ValidationError([{ path: parent.field, message: `${parent.label} not found` }]);
    }
    if (!doc.active) {
      throw new ValidationError([
        { path: parent.field, message: `${parent.label} "${doc.name}" is inactive` },
      ]);
    }
    return doc._id;
  }

  private async assertNoActiveChildren(config: MasterEntityConfig, id: ObjectId): Promise<void> {
    for (const child of config.children ?? []) {
      const count = await this.collection(child.entity).countDocuments({
        [child.field]: id,
        active: true,
      });
      if (count > 0) {
        const plural = child.label === 'city' ? 'cities' : `${child.label}s`;
        throw new ConflictError(
          `This ${config.label.toLowerCase()} has ${count} active ${count === 1 ? child.label : plural}. Deactivate them first.`,
        );
      }
    }
  }

  private async assertNameFree(
    config: MasterEntityConfig,
    nameKey: string,
    parentId: ObjectId | undefined,
    excludeId?: ObjectId,
  ): Promise<void> {
    const filter: Filter<MasterRecordDoc> = { nameKey };
    if (config.parent) filter[config.parent.field] = parentId;
    if (excludeId) filter._id = { $ne: excludeId };
    if (await this.collection(config.key).findOne(filter, { projection: { _id: 1 } })) {
      throw this.duplicate(config);
    }
  }

  private duplicate(config: MasterEntityConfig): ConflictError {
    return new ConflictError(
      config.parent
        ? `A ${config.label.toLowerCase()} with this name already exists in that ${config.parent.label.toLowerCase()}`
        : `A ${config.label.toLowerCase()} with this name already exists`,
    );
  }

  /**
   * Walks up the location chain once per level for the whole page, so a city row also carries
   * its district, division and province (id and name).
   */
  private async ancestry(
    config: MasterEntityConfig,
    docs: MasterRecordDoc[],
  ): Promise<Map<string, Partial<MasterRecord>>> {
    const info = new Map<string, Partial<MasterRecord>>(docs.map((d) => [d._id.toHexString(), {}]));
    let level = config;
    let pointers = new Map<string, ObjectId>();
    if (level.parent) {
      for (const doc of docs) {
        const parentId = doc[level.parent.field];
        if (parentId) pointers.set(doc._id.toHexString(), parentId);
      }
    }
    while (level.parent && pointers.size > 0) {
      const parentConfig = this.config(level.parent.entity);
      const name = levelOf(level.parent.field);
      const ids = [...new Set([...pointers.values()].map((id) => id.toHexString()))].map(
        (id) => new ObjectId(id),
      );
      const projection: Record<string, 1> = { name: 1 };
      if (parentConfig.parent) projection[parentConfig.parent.field] = 1;
      const parents = await this.collection(parentConfig.key)
        .find({ _id: { $in: ids } }, { projection })
        .toArray();
      const byId = new Map(parents.map((p) => [p._id.toHexString(), p]));
      const next = new Map<string, ObjectId>();
      for (const [docId, parentId] of pointers) {
        const entry = info.get(docId) as Record<string, unknown>;
        entry[`${name}Id`] = parentId.toHexString();
        const parent = byId.get(parentId.toHexString());
        if (!parent) continue;
        entry[`${name}Name`] = parent.name;
        const grandParent = parentConfig.parent ? parent[parentConfig.parent.field] : undefined;
        if (grandParent) next.set(docId, grandParent);
      }
      pointers = next;
      level = parentConfig;
    }
    return info;
  }

  private async toDtos(
    config: MasterEntityConfig,
    docs: MasterRecordDoc[],
  ): Promise<MasterRecord[]> {
    const ancestry = config.parent ? await this.ancestry(config, docs) : null;
    return docs.map((doc) => {
      const dto: MasterRecord = {
        id: doc._id.toHexString(),
        code: doc.code,
        name: doc.name,
        active: doc.active,
        rev: doc.rev,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
        ...(ancestry?.get(doc._id.toHexString()) ?? {}),
      };
      for (const field of config.extraFields) dto[field] = doc[field] ?? null;
      return dto;
    });
  }
}
