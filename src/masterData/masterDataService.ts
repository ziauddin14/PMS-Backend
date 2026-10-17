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
  nameKeyOf,
  type MasterEntityConfig,
  type MasterFields,
  type MasterRecordDoc,
} from './definitions.js';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isDuplicateKey(error: unknown): boolean {
  return error instanceof MongoServerError && error.code === 11000;
}

/**
 * Master-data operations. All writes go through the M2 RecordStore (validation, codes,
 * optimistic concurrency, audit). Records are activated/deactivated, never deleted, so historical
 * references stay valid.
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
    if (query.provinceId && !config.parent) {
      throw new ValidationError([{ path: 'provinceId', message: 'Not a filter for this list' }]);
    }
    const filter: Filter<MasterRecordDoc> = {};
    if (query.status !== 'all') filter.active = query.status === 'active';
    if (query.search) filter.nameKey = { $regex: escapeRegex(nameKeyOf(query.search)) };
    if (query.provinceId) filter.provinceId = new ObjectId(query.provinceId);

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

  async create(
    entity: MasterEntityKey,
    input: MasterCreateInput,
    ctx: MutationContext,
  ): Promise<MasterRecord> {
    const config = this.config(entity);
    const data: MasterFields = {
      name: input.name.replace(/\s+/g, ' '),
      nameKey: nameKeyOf(input.name),
      active: true,
    };
    if (config.parent) {
      if (!input.provinceId) {
        throw new ValidationError([
          { path: 'provinceId', message: `${config.parent.label} is required` },
        ]);
      }
      data.provinceId = await this.requireActiveParent(config, input.provinceId);
    } else if (input.provinceId) {
      throw new ValidationError([{ path: 'provinceId', message: 'Not a field of this record' }]);
    }
    await this.assertNameFree(config, data.nameKey, data.provinceId);
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
    const current = await this.findOrThrow(config, id);
    const changes: Partial<MasterFields> = {};

    if (input.name !== undefined) {
      changes.name = input.name.replace(/\s+/g, ' ');
      changes.nameKey = nameKeyOf(input.name);
    }
    if (input.provinceId !== undefined) {
      if (!config.parent) {
        throw new ValidationError([{ path: 'provinceId', message: 'Not a field of this record' }]);
      }
      if (input.provinceId !== current.provinceId?.toHexString()) {
        changes.provinceId = await this.requireActiveParent(config, input.provinceId);
      }
    }
    if (input.active !== undefined) {
      changes.active = input.active;
      if (input.active && config.parent && current.provinceId && changes.provinceId === undefined) {
        await this.requireActiveParent(config, current.provinceId.toHexString());
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
    const provinceId = changes.provinceId ?? current.provinceId;
    if (changes.nameKey !== undefined || changes.provinceId !== undefined) {
      await this.assertNameFree(config, nameKey, provinceId, current._id);
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
        throw new ConflictError(
          `This ${config.label.toLowerCase()} has ${count} active ${child.label}${count === 1 ? '' : 's'}. Deactivate them first.`,
        );
      }
    }
  }

  private async assertNameFree(
    config: MasterEntityConfig,
    nameKey: string,
    provinceId: ObjectId | undefined,
    excludeId?: ObjectId,
  ): Promise<void> {
    const filter: Filter<MasterRecordDoc> = { nameKey };
    if (config.parent) filter.provinceId = provinceId;
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

  private async toDtos(
    config: MasterEntityConfig,
    docs: MasterRecordDoc[],
  ): Promise<MasterRecord[]> {
    let provinceNames = new Map<string, string>();
    if (config.parent) {
      const ids = [...new Set(docs.map((d) => d.provinceId?.toHexString()).filter(Boolean))].map(
        (id) => new ObjectId(id),
      );
      const parents = await this.collection(config.parent.entity)
        .find({ _id: { $in: ids } }, { projection: { name: 1 } })
        .toArray();
      provinceNames = new Map(parents.map((p) => [p._id.toHexString(), p.name]));
    }
    return docs.map((doc) => {
      const dto: MasterRecord = {
        id: doc._id.toHexString(),
        code: doc.code,
        name: doc.name,
        active: doc.active,
        rev: doc.rev,
        createdAt: doc.createdAt.toISOString(),
        updatedAt: doc.updatedAt.toISOString(),
      };
      if (doc.provinceId) {
        dto.provinceId = doc.provinceId.toHexString();
        const name = provinceNames.get(dto.provinceId);
        if (name) dto.provinceName = name;
      }
      return dto;
    });
  }
}
