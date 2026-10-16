import { isDeepStrictEqual } from 'node:util';
import { ObjectId, type ClientSession, type Collection, type Document } from 'mongodb';
import type { z } from 'zod';
import { COLLECTIONS } from '../db/collections.js';
import { nextRecordCode } from '../db/codes.js';
import type { Database } from '../db/mongo.js';
import {
  mutationContextSchema,
  type Actor,
  type MutationContext,
  type Provenance,
} from '../domain/context.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { parseOrThrow } from '../validation.js';

/** A workbook (and optionally sheet) that must later receive this record's changes. */
export interface SyncTarget {
  workbook: string;
  sheet?: string;
}

export interface RecordDefinition<TCreate extends Document, TUpdate extends Document> {
  collection: string;
  codePrefix: string;
  createSchema: z.ZodType<TCreate>;
  updateSchema: z.ZodType<TUpdate>;
  /** Outbound sync jobs are queued for these targets on every change. Consumed in M10. */
  syncTargets?: SyncTarget[];
  /** Fields whose values must never be copied into audit events (e.g. password hashes). */
  auditRedactFields?: string[];
}

export const AUDIT_REDACTED = '[REDACTED]';

export interface Lifecycle {
  state: 'ACTIVE' | 'ARCHIVED';
  archivedAt: Date | null;
  archivedBy: Actor | null;
  archiveReason: string | null;
}

export interface RecordMeta {
  _id: ObjectId;
  code: string;
  rev: number;
  createdAt: Date;
  updatedAt: Date;
  createdBy: Actor;
  updatedBy: Actor;
  lifecycle: Lifecycle;
  provenance?: Provenance;
}

export type StoredRecord<T> = T & RecordMeta;

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export type AuditAction = 'CREATE' | 'UPDATE' | 'ARCHIVE';

export interface AuditEventDoc {
  _id: ObjectId;
  occurredAt: Date;
  actor: Actor;
  action: AuditAction;
  entity: { collection: string; id: ObjectId; code: string };
  revBefore: number | null;
  revAfter: number;
  changes: FieldChange[];
  state: 'COMMITTED' | 'PENDING' | 'FAILED';
  atomic: boolean;
  failureReason: string | null;
  correlationId: string | null;
  requestId: string | null;
  provenance: Provenance | null;
}

export interface SyncJobDoc {
  _id: ObjectId;
  idempotencyKey: string;
  direction: 'OUTBOUND' | 'INBOUND';
  target: SyncTarget;
  entity: { collection: string; id: ObjectId; code: string };
  entityRev: number;
  operation: AuditAction;
  changedFields: string[];
  status: 'PENDING' | 'LEASED' | 'DONE' | 'RETRY' | 'CONFLICT' | 'FAILED';
  attempts: number;
  nextAttemptAt: Date;
  lease: { owner: string; expiresAt: Date } | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const RESERVED_FIELDS = [
  '_id',
  'code',
  'rev',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
  'lifecycle',
  'provenance',
] as const;

interface CommitPlan {
  action: AuditAction;
  collection: string;
  entityId: ObjectId;
  code: string;
  revBefore: number | null;
  revAfter: number;
  changes: FieldChange[];
  context: MutationContext;
  syncTargets: SyncTarget[];
  redactFields: string[];
  now: Date;
}

/**
 * Generic store for operational records. It is the single write path that guarantees:
 * input validation before persistence, a permanent `_id` plus an immutable human code,
 * optimistic concurrency via `rev`, archival instead of deletion, an audit event for every
 * change, and outbound sync jobs for configured targets.
 *
 * With a replica set (Atlas, local replica set) the record write, audit event and sync jobs are
 * committed in one transaction. Without transactions (local standalone development only) a
 * PENDING audit event is written first and marked COMMITTED at the end; events left PENDING or
 * FAILED mark operations that need reconciliation. That fallback is NOT atomic.
 */
export class RecordStore {
  constructor(private readonly database: Database) {}

  private collection(name: string): Collection<Document> {
    return this.database.db.collection(name);
  }

  private get audits(): Collection<AuditEventDoc> {
    return this.database.db.collection<AuditEventDoc>(COLLECTIONS.auditEvents);
  }

  private get syncJobs(): Collection<SyncJobDoc> {
    return this.database.db.collection<SyncJobDoc>(COLLECTIONS.syncJobs);
  }

  async findById<TCreate extends Document, TUpdate extends Document>(
    def: RecordDefinition<TCreate, TUpdate>,
    id: string | ObjectId,
  ): Promise<StoredRecord<TCreate> | null> {
    const objectId = toObjectId(id);
    if (!objectId) return null;
    return (await this.collection(def.collection).findOne({
      _id: objectId,
    })) as StoredRecord<TCreate> | null;
  }

  async create<TCreate extends Document, TUpdate extends Document>(
    def: RecordDefinition<TCreate, TUpdate>,
    input: unknown,
    ctx: MutationContext,
  ): Promise<StoredRecord<TCreate>> {
    const context = parseOrThrow(mutationContextSchema, ctx);
    const data = validatePayload(def.createSchema, input);
    const now = new Date();
    const code = await nextRecordCode(this.database.db, def.codePrefix);
    const _id = new ObjectId();
    const record = {
      ...data,
      _id,
      code,
      rev: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: context.actor,
      updatedBy: context.actor,
      lifecycle: { state: 'ACTIVE', archivedAt: null, archivedBy: null, archiveReason: null },
      ...(context.provenance ? { provenance: context.provenance } : {}),
    } as StoredRecord<TCreate>;

    await this.commit(
      {
        action: 'CREATE',
        collection: def.collection,
        entityId: _id,
        code,
        revBefore: null,
        revAfter: 1,
        changes: Object.entries(data).map(([field, after]) => ({ field, before: null, after })),
        context,
        syncTargets: def.syncTargets ?? [],
        redactFields: def.auditRedactFields ?? [],
        now,
      },
      async (session) => {
        await this.collection(def.collection).insertOne(record, { session });
      },
    );
    return record;
  }

  async update<TCreate extends Document, TUpdate extends Document>(
    def: RecordDefinition<TCreate, TUpdate>,
    id: string | ObjectId,
    expectedRev: number,
    changesInput: unknown,
    ctx: MutationContext,
  ): Promise<StoredRecord<TCreate>> {
    const context = parseOrThrow(mutationContextSchema, ctx);
    const data = validatePayload(def.updateSchema, changesInput);
    if (Object.keys(data).length === 0) {
      throw new ValidationError([{ path: '(root)', message: 'No fields to update' }]);
    }
    const current = await this.loadActive(def.collection, id, expectedRev);

    const changes: FieldChange[] = [];
    const set: Record<string, unknown> = {};
    for (const [field, after] of Object.entries(data)) {
      const before = (current as Document)[field];
      if (!isDeepStrictEqual(before, after)) {
        changes.push({ field, before: before ?? null, after });
        set[field] = after;
      }
    }
    if (changes.length === 0) return current as StoredRecord<TCreate>;

    const now = new Date();
    const revAfter = expectedRev + 1;
    await this.commit(
      {
        action: 'UPDATE',
        collection: def.collection,
        entityId: current._id,
        code: current.code,
        revBefore: expectedRev,
        revAfter,
        changes,
        context,
        syncTargets: def.syncTargets ?? [],
        redactFields: def.auditRedactFields ?? [],
        now,
      },
      async (session) => {
        const result = await this.collection(def.collection).updateOne(
          { _id: current._id, rev: expectedRev, 'lifecycle.state': 'ACTIVE' },
          { $set: { ...set, updatedAt: now, updatedBy: context.actor }, $inc: { rev: 1 } },
          { session },
        );
        if (result.matchedCount === 0) throw staleRevision(expectedRev);
      },
    );
    return {
      ...current,
      ...set,
      rev: revAfter,
      updatedAt: now,
      updatedBy: context.actor,
    } as StoredRecord<TCreate>;
  }

  /** Archives a record (no hard delete). The record stays readable and fully audited. */
  async archive<TCreate extends Document, TUpdate extends Document>(
    def: RecordDefinition<TCreate, TUpdate>,
    id: string | ObjectId,
    expectedRev: number,
    reason: string,
    ctx: MutationContext,
  ): Promise<StoredRecord<TCreate>> {
    const context = parseOrThrow(mutationContextSchema, ctx);
    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (trimmedReason.length === 0 || trimmedReason.length > 500) {
      throw new ValidationError([
        { path: 'reason', message: 'Archive reason must be 1-500 characters' },
      ]);
    }
    const current = await this.loadActive(def.collection, id, expectedRev);
    const now = new Date();
    const revAfter = expectedRev + 1;
    const lifecycle: Lifecycle = {
      state: 'ARCHIVED',
      archivedAt: now,
      archivedBy: context.actor,
      archiveReason: trimmedReason,
    };

    await this.commit(
      {
        action: 'ARCHIVE',
        collection: def.collection,
        entityId: current._id,
        code: current.code,
        revBefore: expectedRev,
        revAfter,
        changes: [
          { field: 'lifecycle.state', before: 'ACTIVE', after: 'ARCHIVED' },
          { field: 'lifecycle.archiveReason', before: null, after: trimmedReason },
        ],
        context,
        syncTargets: def.syncTargets ?? [],
        redactFields: def.auditRedactFields ?? [],
        now,
      },
      async (session) => {
        const result = await this.collection(def.collection).updateOne(
          { _id: current._id, rev: expectedRev, 'lifecycle.state': 'ACTIVE' },
          { $set: { lifecycle, updatedAt: now, updatedBy: context.actor }, $inc: { rev: 1 } },
          { session },
        );
        if (result.matchedCount === 0) throw staleRevision(expectedRev);
      },
    );
    return {
      ...current,
      lifecycle,
      rev: revAfter,
      updatedAt: now,
      updatedBy: context.actor,
    } as StoredRecord<TCreate>;
  }

  /** Audit events of non-atomic operations that did not complete (fallback mode only). */
  async findIncompleteAuditEvents(): Promise<AuditEventDoc[]> {
    return this.audits
      .find({ state: { $in: ['PENDING', 'FAILED'] } })
      .sort({ occurredAt: 1 })
      .toArray();
  }

  private async loadActive(collection: string, id: string | ObjectId, expectedRev: number) {
    if (!Number.isInteger(expectedRev) || expectedRev < 1) {
      throw new ValidationError([
        { path: 'rev', message: 'Expected revision must be a positive integer' },
      ]);
    }
    const objectId = toObjectId(id);
    if (!objectId) throw new NotFoundError('Record not found');
    const current = (await this.collection(collection).findOne({ _id: objectId })) as
      (Document & RecordMeta) | null;
    if (!current) throw new NotFoundError('Record not found');
    if (current.lifecycle?.state !== 'ACTIVE') throw new ConflictError('Record is archived');
    if (current.rev !== expectedRev) throw staleRevision(expectedRev);
    return current;
  }

  private async commit(
    plan: CommitPlan,
    write: (session: ClientSession | undefined) => Promise<void>,
  ): Promise<void> {
    const audit = buildAuditEvent(plan);
    const jobs = buildSyncJobs(plan);

    if (this.database.supportsTransactions) {
      const session = this.database.client.startSession();
      try {
        await session.withTransaction(async () => {
          await write(session);
          await this.audits.insertOne({ ...audit, state: 'COMMITTED', atomic: true }, { session });
          if (jobs.length > 0) await this.syncJobs.insertMany(jobs, { session });
        });
      } finally {
        await session.endSession();
      }
      return;
    }

    // Non-transactional fallback (development only): intent first, then the change.
    await this.audits.insertOne({ ...audit, state: 'PENDING', atomic: false });
    let recordWritten = false;
    try {
      await write(undefined);
      recordWritten = true;
      if (jobs.length > 0) await this.syncJobs.insertMany(jobs);
      await this.audits.updateOne({ _id: audit._id }, { $set: { state: 'COMMITTED' } });
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'UnknownError';
      const update = recordWritten
        ? // The record changed but a later step failed: leave PENDING for reconciliation.
          { failureReason: `Record written but follow-up step failed (${reason}); reconcile` }
        : { state: 'FAILED' as const, failureReason: `Record write failed (${reason})` };
      await this.audits.updateOne({ _id: audit._id }, { $set: update }).catch(() => undefined);
      throw error;
    }
  }
}

function buildAuditEvent(plan: CommitPlan): AuditEventDoc {
  return {
    _id: new ObjectId(),
    occurredAt: plan.now,
    actor: plan.context.actor,
    action: plan.action,
    entity: { collection: plan.collection, id: plan.entityId, code: plan.code },
    revBefore: plan.revBefore,
    revAfter: plan.revAfter,
    changes: plan.changes.map((change) =>
      plan.redactFields.includes(change.field)
        ? { field: change.field, before: AUDIT_REDACTED, after: AUDIT_REDACTED }
        : change,
    ),
    state: 'PENDING',
    atomic: false,
    failureReason: null,
    correlationId: plan.context.correlationId ?? null,
    requestId: plan.context.requestId ?? null,
    provenance: plan.context.provenance ?? null,
  };
}

function buildSyncJobs(plan: CommitPlan): SyncJobDoc[] {
  return plan.syncTargets.map((target) => ({
    _id: new ObjectId(),
    idempotencyKey: [
      plan.collection,
      plan.entityId.toHexString(),
      plan.revAfter,
      target.workbook,
      target.sheet ?? '*',
    ].join(':'),
    direction: 'OUTBOUND',
    target,
    entity: { collection: plan.collection, id: plan.entityId, code: plan.code },
    entityRev: plan.revAfter,
    operation: plan.action,
    changedFields: plan.changes.map((change) => change.field),
    status: 'PENDING',
    attempts: 0,
    nextAttemptAt: plan.now,
    lease: null,
    lastError: null,
    createdAt: plan.now,
    updatedAt: plan.now,
  }));
}

function validatePayload<T extends Document>(schema: z.ZodType<T>, input: unknown): T {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError([{ path: '(root)', message: 'Expected an object' }]);
  }
  const reserved = RESERVED_FIELDS.filter((field) => Object.hasOwn(input, field));
  if (reserved.length > 0) {
    throw new ValidationError(
      reserved.map((field) => ({ path: field, message: 'This field is managed by the system' })),
    );
  }
  const data = parseOrThrow(schema, input);
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)) as T;
}

function toObjectId(id: string | ObjectId): ObjectId | null {
  if (id instanceof ObjectId) return id;
  return typeof id === 'string' && /^[a-f0-9]{24}$/.test(id) ? new ObjectId(id) : null;
}

function staleRevision(expectedRev: number): ConflictError {
  return new ConflictError(
    `Record was changed by someone else (expected revision ${expectedRev}); reload and try again`,
  );
}
