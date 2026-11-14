import { ObjectId, type Collection, type Db, type Filter } from 'mongodb';
import { z } from 'zod';
import type {
  CancelWithReasonInput,
  Payment,
  PaymentCreateInput,
  PaymentListQuery,
  PaymentListResponse,
} from '../contracts/operations.js';
import { ensureCollection, recordCollectionSpec } from '../db/collections.js';
import type { Database } from '../db/mongo.js';
import { todayInKarachi } from '../demands/demandService.js';
import type { MutationContext } from '../domain/context.js';
import { ConflictError, NotFoundError, ValidationError, type ErrorDetail } from '../errors.js';
import {
  actorLabel,
  addToTally,
  escapeRegex,
  fetchMasterMap,
  readTallies,
  refOf,
  tallyKey,
  toCents,
  type RefDocs,
} from '../inventory/ledger.js';
import {
  PURCHASE_ORDERS_COLLECTION,
  type PurchaseOrderDoc,
} from '../purchaseOrders/definitions.js';
import type { RecordDefinition, RecordStore, StoredRecord } from '../records/recordStore.js';

export const PAYMENTS_COLLECTION = 'vendor_payments';

export interface PaymentFields {
  purchaseOrderId: ObjectId;
  purchaseOrderCode: string;
  poNumber: string;
  vendorId: ObjectId;
  paymentDate: string;
  amount: number;
  method: 'BANK_TRANSFER' | 'CHEQUE' | 'CASH' | 'OTHER';
  reference: string | null;
  scheduleEntryNo: number | null;
  notes: string | null;
  documents: Array<{ label: string; url: string }>;
  searchText: string;
  [key: string]: unknown;
}
export type PaymentDoc = StoredRecord<PaymentFields>;

const objectId = z.instanceof(ObjectId);
const fieldsSchema = z
  .object({
    purchaseOrderId: objectId,
    purchaseOrderCode: z.string(),
    poNumber: z.string(),
    vendorId: objectId,
    paymentDate: z.string(),
    amount: z.number().positive(),
    method: z.enum(['BANK_TRANSFER', 'CHEQUE', 'CASH', 'OTHER']),
    reference: z.string().nullable(),
    scheduleEntryNo: z.number().int().nullable(),
    notes: z.string().nullable(),
    documents: z.array(z.object({ label: z.string(), url: z.string() }).strict()),
    searchText: z.string(),
  })
  .strict();

export const paymentDefinition: RecordDefinition<PaymentFields, Partial<PaymentFields>> = {
  collection: PAYMENTS_COLLECTION,
  codePrefix: 'PAY',
  createSchema: fieldsSchema as unknown as z.ZodType<PaymentFields>,
  updateSchema: fieldsSchema.partial() as unknown as z.ZodType<Partial<PaymentFields>>,
  syncTargets: [{ workbook: 'PRD', sheet: 'PO' }],
};

export const paymentsCollectionSpec = recordCollectionSpec(PAYMENTS_COLLECTION, {
  required: ['purchaseOrderId', 'vendorId', 'paymentDate', 'amount', 'method', 'searchText'],
  properties: {
    purchaseOrderId: { bsonType: 'objectId' },
    vendorId: { bsonType: 'objectId' },
    paymentDate: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    amount: { bsonType: ['int', 'long', 'double'], minimum: 0, exclusiveMinimum: true },
    method: { enum: ['BANK_TRANSFER', 'CHEQUE', 'CASH', 'OTHER'] },
    reference: { bsonType: ['string', 'null'], maxLength: 100 },
    notes: { bsonType: ['string', 'null'], maxLength: 1000 },
  },
  indexes: [
    { key: { 'lifecycle.state': 1, paymentDate: -1, code: -1 }, name: 'state_date' },
    { key: { purchaseOrderId: 1, paymentDate: -1 }, name: 'po_date' },
    { key: { vendorId: 1, paymentDate: -1 }, name: 'vendor_date' },
  ],
});

export async function ensurePaymentCollections(db: Db): Promise<void> {
  await ensureCollection(db, paymentsCollectionSpec);
}

/**
 * Vendor payments (M9): actual payment transactions against a PO, separate from the planned
 * schedule recorded on the PO. The total of active payments can never exceed the PO's approved
 * amount (guarded tally, in cents). Payment status is independent of PO completion.
 * Payments are corrected by cancelling them (with reason).
 */
export class PaymentService {
  constructor(
    private readonly database: Database,
    private readonly store: RecordStore,
  ) {}

  private get payments(): Collection<PaymentDoc> {
    return this.database.db.collection<PaymentDoc>(PAYMENTS_COLLECTION);
  }

  async list(query: PaymentListQuery): Promise<PaymentListResponse> {
    const filter: Filter<PaymentDoc> = {};
    if (query.status === 'open') filter['lifecycle.state'] = 'ACTIVE';
    if (query.status === 'cancelled') filter['lifecycle.state'] = 'ARCHIVED';
    if (query.purchaseOrderId) filter.purchaseOrderId = new ObjectId(query.purchaseOrderId);
    if (query.vendorId) filter.vendorId = new ObjectId(query.vendorId);
    if (query.from || query.to) {
      filter.paymentDate = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }
    if (query.search) {
      const pattern = escapeRegex(query.search.toLowerCase().replace(/\s+/g, ' '));
      filter.$or = [
        { code: { $regex: pattern, $options: 'i' } },
        { searchText: { $regex: pattern } },
      ];
    }
    const [docs, total] = await Promise.all([
      this.payments
        .find(filter)
        .sort({ paymentDate: -1, code: -1 })
        .skip((query.page - 1) * query.pageSize)
        .limit(query.pageSize)
        .toArray(),
      this.payments.countDocuments(filter),
    ]);
    const vendors = await this.vendorMap(docs);
    return {
      items: docs.map((doc) => this.toDto(doc, vendors)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async get(id: string): Promise<Payment> {
    const doc = await this.findOrThrow(id);
    return this.toDto(doc, await this.vendorMap([doc]));
  }

  async create(input: PaymentCreateInput, ctx: MutationContext): Promise<Payment> {
    const db = this.database.db;
    const po = await db
      .collection<PurchaseOrderDoc>(PURCHASE_ORDERS_COLLECTION)
      .findOne({ _id: new ObjectId(input.purchaseOrderId) });
    if (!po) {
      throw new ValidationError([{ path: 'purchaseOrderId', message: 'Purchase order not found' }]);
    }
    if (po.lifecycle.state !== 'ACTIVE') {
      throw new ConflictError('This purchase order is cancelled; payments cannot be recorded');
    }
    const errors: ErrorDetail[] = [];
    if (input.paymentDate > todayInKarachi()) {
      errors.push({ path: 'paymentDate', message: 'Date cannot be in the future' });
    } else if (input.paymentDate < '2000-01-01') {
      errors.push({ path: 'paymentDate', message: 'Date must be on or after 2000-01-01' });
    }
    const scheduleEntryNo = input.scheduleEntryNo ?? null;
    if (
      scheduleEntryNo !== null &&
      !po.paymentSchedule.some((s) => s.entryNo === scheduleEntryNo)
    ) {
      errors.push({ path: 'scheduleEntryNo', message: 'This PO has no such schedule entry' });
    }
    const approvedCents = toCents(po.approvedAmount);
    const paidCents =
      (await readTallies(db, [tallyKey.paidCents(po._id)])).get(tallyKey.paidCents(po._id)) ?? 0;
    const amountCents = toCents(input.amount);
    if (paidCents + amountCents > approvedCents) {
      errors.push({
        path: 'amount',
        message: `Amount exceeds the outstanding balance (${((approvedCents - paidCents) / 100).toFixed(2)})`,
      });
    }
    if (errors.length > 0) throw new ValidationError(errors);

    const fields: PaymentFields = {
      purchaseOrderId: po._id,
      purchaseOrderCode: po.code,
      poNumber: po.poNumber,
      vendorId: po.vendorId,
      paymentDate: input.paymentDate,
      amount: amountCents / 100,
      method: input.method,
      reference: input.reference ?? null,
      scheduleEntryNo,
      notes: input.notes ?? null,
      documents: input.documents.map((d) => ({ label: d.label, url: d.url })),
      searchText: [po.poNumber, po.code, input.reference ?? '', input.notes ?? '']
        .join(' ')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim(),
    };
    const created = (await this.store.create(paymentDefinition, fields, ctx, async (session) => {
      const ok = await addToTally(
        db,
        session,
        tallyKey.paidCents(po._id),
        amountCents,
        approvedCents,
      );
      if (!ok) {
        throw new ConflictError(
          'Payments would exceed the approved PO amount (another payment may have just been recorded); reload and try again',
        );
      }
    })) as PaymentDoc;
    return this.toDto(created, await this.vendorMap([created]));
  }

  async cancel(id: string, input: CancelWithReasonInput, ctx: MutationContext): Promise<Payment> {
    const current = await this.findOrThrow(id);
    if (current.lifecycle.state !== 'ACTIVE') {
      throw new ConflictError('This payment is already cancelled');
    }
    const db = this.database.db;
    const cancelled = (await this.store.archive(
      paymentDefinition,
      current._id,
      input.rev,
      input.reason,
      ctx,
      async (session) => {
        await addToTally(
          db,
          session,
          tallyKey.paidCents(current.purchaseOrderId),
          -toCents(current.amount),
        );
      },
    )) as PaymentDoc;
    return this.toDto(cancelled, await this.vendorMap([cancelled]));
  }

  private async findOrThrow(id: string): Promise<PaymentDoc> {
    if (!ObjectId.isValid(id)) throw new NotFoundError('Payment not found');
    const doc = await this.payments.findOne({ _id: new ObjectId(id) });
    if (!doc) throw new NotFoundError('Payment not found');
    return doc;
  }

  private vendorMap(docs: PaymentDoc[]): Promise<RefDocs> {
    return fetchMasterMap(
      this.database.db,
      'vendors',
      docs.map((d) => d.vendorId.toHexString()),
    );
  }

  private toDto(doc: PaymentDoc, vendors: RefDocs): Payment {
    const { lifecycle } = doc;
    return {
      id: doc._id.toHexString(),
      code: doc.code,
      paymentDate: doc.paymentDate,
      status: lifecycle.state === 'ACTIVE' ? 'ACTIVE' : 'CANCELLED',
      purchaseOrder: {
        id: doc.purchaseOrderId.toHexString(),
        code: doc.purchaseOrderCode,
        poNumber: doc.poNumber,
      },
      vendor: refOf(vendors, doc.vendorId),
      amount: doc.amount,
      method: doc.method,
      reference: doc.reference,
      scheduleEntryNo: doc.scheduleEntryNo,
      notes: doc.notes,
      documents: doc.documents,
      rev: doc.rev,
      createdAt: doc.createdAt.toISOString(),
      createdBy: actorLabel(doc.createdBy),
      cancellation:
        lifecycle.state === 'ARCHIVED' && lifecycle.archivedAt
          ? {
              at: lifecycle.archivedAt.toISOString(),
              reason: lifecycle.archiveReason ?? '',
              by: actorLabel(lifecycle.archivedBy),
            }
          : null,
    };
  }
}
