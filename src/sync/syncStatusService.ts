import { ObjectId, type Filter } from 'mongodb';
import type { SyncJob, SyncJobQuery, SyncSummary } from '../contracts/operations.js';
import { COLLECTIONS } from '../db/collections.js';
import type { Database } from '../db/mongo.js';
import { ConflictError, NotFoundError } from '../errors.js';
import type { SyncJobDoc } from '../records/recordStore.js';

export const SYNC_PROCESSOR_NOTE =
  'Changes are queued for the Excel workbooks (outbox) but are not written to any workbook yet. ' +
  'Connecting the real workbooks (Google Drive) needs separate written authorisation; until then ' +
  'nothing in the organisation workbooks is read or changed.';

/**
 * Excel sync monitoring (M10). Every PMS change queues an idempotent outbound job (M2 outbox).
 * This service reports queue health and lets the operator re-queue FAILED/CONFLICT jobs. The
 * workbook processor itself is not enabled: touching real workbooks needs authorisation.
 */
export class SyncStatusService {
  constructor(private readonly database: Database) {}

  private get jobs() {
    return this.database.db.collection<SyncJobDoc>(COLLECTIONS.syncJobs);
  }

  async summary(): Promise<SyncSummary> {
    const [byStatus, byTarget, oldest] = await Promise.all([
      this.jobs
        .aggregate<{ _id: SyncJobDoc['status']; count: number }>([
          { $group: { _id: '$status', count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
      this.jobs
        .aggregate<{
          _id: { workbook: string; sheet: string | null };
          pending: number;
          failed: number;
          conflict: number;
          done: number;
        }>([
          {
            $group: {
              _id: { workbook: '$target.workbook', sheet: { $ifNull: ['$target.sheet', null] } },
              pending: {
                $sum: { $cond: [{ $in: ['$status', ['PENDING', 'RETRY', 'LEASED']] }, 1, 0] },
              },
              failed: { $sum: { $cond: [{ $eq: ['$status', 'FAILED'] }, 1, 0] } },
              conflict: { $sum: { $cond: [{ $eq: ['$status', 'CONFLICT'] }, 1, 0] } },
              done: { $sum: { $cond: [{ $eq: ['$status', 'DONE'] }, 1, 0] } },
            },
          },
          { $sort: { '_id.workbook': 1, '_id.sheet': 1 } },
        ])
        .toArray(),
      this.jobs.find({ status: 'PENDING' }).sort({ createdAt: 1 }).limit(1).toArray(),
    ]);
    return {
      processorEnabled: false,
      processorNote: SYNC_PROCESSOR_NOTE,
      byStatus: byStatus.map((row) => ({ status: row._id, count: row.count })),
      byTarget: byTarget.map((row) => ({
        workbook: row._id.workbook,
        sheet: row._id.sheet,
        pending: row.pending,
        failed: row.failed,
        conflict: row.conflict,
        done: row.done,
      })),
      oldestPendingAt: oldest[0]?.createdAt.toISOString() ?? null,
    };
  }

  async list(query: SyncJobQuery) {
    const filter: Filter<SyncJobDoc> = {};
    if (query.status) filter.status = query.status;
    if (query.workbook) filter['target.workbook'] = query.workbook;
    const [docs, total] = await Promise.all([
      this.jobs
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .toArray(),
      this.jobs.countDocuments(filter),
    ]);
    return { items: docs.map(toDto), page: query.page, pageSize: query.pageSize, total };
  }

  /** Re-queues a FAILED or CONFLICT job. Conflicts must be resolved in the workbook first. */
  async retry(id: string): Promise<SyncJob> {
    if (!ObjectId.isValid(id)) throw new NotFoundError('Sync job not found');
    const now = new Date();
    const updated = await this.jobs.findOneAndUpdate(
      { _id: new ObjectId(id), status: { $in: ['FAILED', 'CONFLICT'] } },
      { $set: { status: 'RETRY', nextAttemptAt: now, updatedAt: now, lease: null } },
      { returnDocument: 'after' },
    );
    if (!updated) {
      const exists = await this.jobs.findOne({ _id: new ObjectId(id) }, { projection: { _id: 1 } });
      if (!exists) throw new NotFoundError('Sync job not found');
      throw new ConflictError('Only failed or conflicting sync jobs can be retried');
    }
    return toDto(updated);
  }
}

function toDto(doc: SyncJobDoc): SyncJob {
  return {
    id: doc._id.toHexString(),
    workbook: doc.target.workbook,
    sheet: doc.target.sheet ?? null,
    entity: {
      collection: doc.entity.collection,
      id: doc.entity.id.toHexString(),
      code: doc.entity.code,
    },
    entityRev: doc.entityRev,
    operation: doc.operation,
    status: doc.status,
    attempts: doc.attempts,
    lastError: doc.lastError,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
