import { z } from 'zod';
import { dateOnlySchema, masterRefSchema, objectIdStringSchema } from './api.js';

/**
 * Contracts for M7 (receiving & stock), M8 (dispatch, Bilty & documents), M9 (vendor payments),
 * M10 (sync status) and M11 (reports). Mirrored in the frontend `src/contracts/operations.ts`.
 */

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { message: `${label} must be at most ${max} characters` })
    .refine((value) => !/\p{Cc}/u.test(value), { message: `${label} contains invalid characters` })
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional();

const quantitySchema = z
  .number({ message: 'Quantity is required' })
  .int({ message: 'Quantity must be a whole number' })
  .min(1, { message: 'Quantity must be at least 1' })
  .max(10_000_000, { message: 'Quantity is too large' });

const revSchema = z.number({ message: 'rev is required' }).int().min(1);

export const cancelWithReasonSchema = z
  .object({
    rev: revSchema,
    reason: z
      .string({ message: 'Reason is required' })
      .trim()
      .min(1, { message: 'Reason is required' })
      .max(500, { message: 'Reason must be at most 500 characters' }),
  })
  .strict();
export type CancelWithReasonInput = z.infer<typeof cancelWithReasonSchema>;

const pageSchema = z.coerce.number().int().min(1).max(10000).default(1);
const pageSizeSchema = z.coerce.number().int().min(1).max(100).default(25);
const statusFilterSchema = z.enum(['open', 'cancelled', 'all']).default('open');

function dateRangeRefine<T extends { from?: string | undefined; to?: string | undefined }>(v: T) {
  return !v.from || !v.to || v.from <= v.to;
}
const dateRangeMessage = { message: '"from" must not be after "to"', path: ['from'] };

/** Supporting document reference (e.g. a Google Drive link). Files are not stored by the PMS. */
export const documentRefInputSchema = z
  .object({
    label: z
      .string({ message: 'Document name is required' })
      .trim()
      .min(1, { message: 'Document name is required' })
      .max(100, { message: 'Document name must be at most 100 characters' }),
    url: z
      .string({ message: 'Link is required' })
      .trim()
      .max(1000, { message: 'Link is too long' })
      .refine((value) => /^https:\/\/[^\s]+$/i.test(value), {
        message: 'Link must start with https://',
      }),
  })
  .strict();
export type DocumentRefInput = z.infer<typeof documentRefInputSchema>;
export const documentRefSchema = z.object({ label: z.string(), url: z.string() });
export type DocumentRef = z.infer<typeof documentRefSchema>;
const documentsInputSchema = z
  .array(documentRefInputSchema)
  .max(20, { message: 'At most 20 documents' })
  .optional()
  .default([]);

export const stockLocationKinds = ['WAREHOUSE', 'DIVISION'] as const;
export type StockLocationKind = (typeof stockLocationKinds)[number];
export const stockLocationKindSchema = z.enum(stockLocationKinds);

export const stockLocationSchema = z.object({
  kind: stockLocationKindSchema,
  id: z.string(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
});
export type StockLocation = z.infer<typeof stockLocationSchema>;

export const poLotRefSchema = z.object({
  purchaseOrderId: z.string(),
  purchaseOrderCode: z.string(),
  poNumber: z.string(),
  poLineId: z.string(),
  poLineNo: z.number().int(),
});
export type PoLotRef = z.infer<typeof poLotRefSchema>;

const cancellationSchema = z
  .object({ at: z.string(), reason: z.string(), by: z.string().nullable() })
  .nullable();

// ---------------------------------------------------------------------------------------------
// M7 — Goods receiving
// ---------------------------------------------------------------------------------------------

export const receiptCreateSchema = z
  .object({
    purchaseOrderId: objectIdStringSchema,
    receiptDate: dateOnlySchema,
    vendorChallanNo: optionalText(50, 'Vendor challan number'),
    notes: optionalText(1000, 'Notes'),
    lines: z
      .array(z.object({ poLineId: objectIdStringSchema, quantity: quantitySchema }).strict())
      .min(1, { message: 'Receive at least one line' })
      .max(200, { message: 'At most 200 lines' }),
  })
  .strict();
export type ReceiptCreateInput = z.infer<typeof receiptCreateSchema>;

export const receiptListQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: statusFilterSchema,
    purchaseOrderId: objectIdStringSchema.optional(),
    vendorId: objectIdStringSchema.optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .strict()
  .refine(dateRangeRefine, dateRangeMessage);
export type ReceiptListQuery = z.infer<typeof receiptListQuerySchema>;

export const receiptLineSchema = z.object({
  id: z.string(),
  poLineId: z.string(),
  poLineNo: z.number().int(),
  item: masterRefSchema,
  quantity: z.number().int(),
});
export type ReceiptLine = z.infer<typeof receiptLineSchema>;

export const receiptSummarySchema = z.object({
  id: z.string(),
  code: z.string(),
  receiptDate: z.string(),
  status: z.enum(['ACTIVE', 'CANCELLED']),
  purchaseOrder: z.object({ id: z.string(), code: z.string(), poNumber: z.string() }),
  vendor: masterRefSchema,
  deliveryRoute: z.enum(['WAREHOUSE', 'DIRECT']),
  location: stockLocationSchema,
  vendorChallanNo: z.string().nullable(),
  totalQuantity: z.number().int(),
  lineCount: z.number().int(),
  rev: z.number().int(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
export type ReceiptSummary = z.infer<typeof receiptSummarySchema>;

export const receiptDetailSchema = receiptSummarySchema.extend({
  notes: z.string().nullable(),
  lines: z.array(receiptLineSchema),
  cancellation: cancellationSchema,
});
export type ReceiptDetail = z.infer<typeof receiptDetailSchema>;

export const receiptListResponseSchema = z.object({
  items: z.array(receiptSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type ReceiptListResponse = z.infer<typeof receiptListResponseSchema>;

// ---------------------------------------------------------------------------------------------
// M7 — Stock balances and inventory ledger
// ---------------------------------------------------------------------------------------------

export const stockBalanceQuerySchema = z
  .object({
    locationKind: stockLocationKindSchema.optional(),
    locationId: objectIdStringSchema.optional(),
    itemId: objectIdStringSchema.optional(),
    purchaseOrderId: objectIdStringSchema.optional(),
    includeZero: z.enum(['true', 'false']).default('false'),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .strict();
export type StockBalanceQuery = z.infer<typeof stockBalanceQuerySchema>;

export const stockBalanceSchema = z.object({
  location: stockLocationSchema,
  item: masterRefSchema,
  lot: poLotRefSchema,
  quantity: z.number().int(),
});
export type StockBalance = z.infer<typeof stockBalanceSchema>;

export const stockBalanceResponseSchema = z.object({
  items: z.array(stockBalanceSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
  /** Units held across every row matching the filter (not only this page). */
  totalQuantity: z.number().int(),
});
export type StockBalanceResponse = z.infer<typeof stockBalanceResponseSchema>;

export const stockMovementTypes = [
  'RECEIPT',
  'RECEIPT_CANCELLED',
  'DISPATCH',
  'DISPATCH_CANCELLED',
] as const;
export type StockMovementType = (typeof stockMovementTypes)[number];

export const stockMovementQuerySchema = z
  .object({
    locationKind: stockLocationKindSchema.optional(),
    locationId: objectIdStringSchema.optional(),
    itemId: objectIdStringSchema.optional(),
    purchaseOrderId: objectIdStringSchema.optional(),
    type: z.enum(stockMovementTypes).optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .strict()
  .refine(dateRangeRefine, dateRangeMessage);
export type StockMovementQuery = z.infer<typeof stockMovementQuerySchema>;

export const stockMovementSchema = z.object({
  id: z.string(),
  movementDate: z.string(),
  recordedAt: z.string(),
  type: z.enum(stockMovementTypes),
  location: stockLocationSchema,
  item: masterRefSchema,
  lot: poLotRefSchema,
  /** Positive = into the location, negative = out of it. */
  quantity: z.number().int(),
  source: z.object({ kind: z.enum(['RECEIPT', 'DISPATCH']), id: z.string(), code: z.string() }),
  by: z.string().nullable(),
});
export type StockMovement = z.infer<typeof stockMovementSchema>;

export const stockMovementResponseSchema = z.object({
  items: z.array(stockMovementSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type StockMovementResponse = z.infer<typeof stockMovementResponseSchema>;

// ---------------------------------------------------------------------------------------------
// M8 — Dispatch, Bilty and documents
// ---------------------------------------------------------------------------------------------

export const dispatchCreateSchema = z
  .object({
    dispatchDate: dateOnlySchema,
    sourceKind: stockLocationKindSchema,
    sourceId: objectIdStringSchema,
    destinationDivisionId: objectIdStringSchema,
    demandId: objectIdStringSchema.nullable().optional(),
    biltyNo: optionalText(50, 'Bilty number'),
    transporterName: optionalText(100, 'Transporter'),
    vehicleNo: optionalText(30, 'Vehicle number'),
    freightAmount: z
      .number()
      .min(0, { message: 'Freight cannot be negative' })
      .max(1_000_000_000)
      .nullable()
      .optional(),
    notes: optionalText(1000, 'Notes'),
    documents: documentsInputSchema,
    lines: z
      .array(
        z
          .object({
            poLineId: objectIdStringSchema,
            quantity: quantitySchema,
            demandLineId: objectIdStringSchema.nullable().optional(),
          })
          .strict(),
      )
      .min(1, { message: 'Dispatch at least one line' })
      .max(200, { message: 'At most 200 lines' }),
  })
  .strict();
export type DispatchCreateInput = z.infer<typeof dispatchCreateSchema>;

/** Bilty / transport details and documents can be completed after the dispatch is recorded. */
export const dispatchUpdateSchema = z
  .object({
    rev: revSchema,
    biltyNo: optionalText(50, 'Bilty number'),
    transporterName: optionalText(100, 'Transporter'),
    vehicleNo: optionalText(30, 'Vehicle number'),
    freightAmount: z.number().min(0).max(1_000_000_000).nullable().optional(),
    notes: optionalText(1000, 'Notes'),
    documents: z.array(documentRefInputSchema).max(20).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((key) => key !== 'rev'), { message: 'Nothing to update' });
export type DispatchUpdateInput = z.infer<typeof dispatchUpdateSchema>;

export const dispatchListQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: statusFilterSchema,
    destinationDivisionId: objectIdStringSchema.optional(),
    sourceKind: stockLocationKindSchema.optional(),
    sourceId: objectIdStringSchema.optional(),
    demandId: objectIdStringSchema.optional(),
    purchaseOrderId: objectIdStringSchema.optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .strict()
  .refine(dateRangeRefine, dateRangeMessage);
export type DispatchListQuery = z.infer<typeof dispatchListQuerySchema>;

export const dispatchLineSchema = z.object({
  id: z.string(),
  lineNo: z.number().int(),
  item: masterRefSchema,
  lot: poLotRefSchema,
  quantity: z.number().int(),
  demandLine: z
    .object({ demandId: z.string(), demandCode: z.string(), lineNo: z.number().int() })
    .nullable(),
});
export type DispatchLine = z.infer<typeof dispatchLineSchema>;

export const dispatchSummarySchema = z.object({
  id: z.string(),
  code: z.string(),
  dispatchDate: z.string(),
  status: z.enum(['ACTIVE', 'CANCELLED']),
  source: stockLocationSchema,
  destinationDivision: masterRefSchema.extend({ provinceName: z.string().nullable() }),
  demand: z.object({ id: z.string(), code: z.string() }).nullable(),
  biltyNo: z.string().nullable(),
  transporterName: z.string().nullable(),
  vehicleNo: z.string().nullable(),
  totalQuantity: z.number().int(),
  lineCount: z.number().int(),
  rev: z.number().int(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
});
export type DispatchSummary = z.infer<typeof dispatchSummarySchema>;

export const dispatchDetailSchema = dispatchSummarySchema.extend({
  freightAmount: z.number().nullable(),
  notes: z.string().nullable(),
  documents: z.array(documentRefSchema),
  lines: z.array(dispatchLineSchema),
  cancellation: cancellationSchema,
});
export type DispatchDetail = z.infer<typeof dispatchDetailSchema>;

export const dispatchListResponseSchema = z.object({
  items: z.array(dispatchSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type DispatchListResponse = z.infer<typeof dispatchListResponseSchema>;

// ---------------------------------------------------------------------------------------------
// M9 — Vendor payments
// ---------------------------------------------------------------------------------------------

export const paymentMethods = ['BANK_TRANSFER', 'CHEQUE', 'CASH', 'OTHER'] as const;
export type PaymentMethod = (typeof paymentMethods)[number];

const moneySchema = z
  .number({ message: 'Amount is required' })
  .positive({ message: 'Amount must be greater than 0' })
  .max(100_000_000_000, { message: 'Amount is too large' })
  .refine((v) => Math.round(v * 100) === Math.round(v * 100 * 1e6) / 1e6, {
    message: 'Amount may have at most 2 decimals',
  });

export const paymentCreateSchema = z
  .object({
    purchaseOrderId: objectIdStringSchema,
    paymentDate: dateOnlySchema,
    amount: moneySchema,
    method: z.enum(paymentMethods),
    reference: optionalText(100, 'Payment reference'),
    scheduleEntryNo: z.number().int().min(1).nullable().optional(),
    notes: optionalText(1000, 'Notes'),
    documents: documentsInputSchema,
  })
  .strict();
export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;

export const paymentListQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: statusFilterSchema,
    purchaseOrderId: objectIdStringSchema.optional(),
    vendorId: objectIdStringSchema.optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .strict()
  .refine(dateRangeRefine, dateRangeMessage);
export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;

export const paymentSchema = z.object({
  id: z.string(),
  code: z.string(),
  paymentDate: z.string(),
  status: z.enum(['ACTIVE', 'CANCELLED']),
  purchaseOrder: z.object({ id: z.string(), code: z.string(), poNumber: z.string() }),
  vendor: masterRefSchema,
  amount: z.number(),
  method: z.enum(paymentMethods),
  reference: z.string().nullable(),
  scheduleEntryNo: z.number().int().nullable(),
  notes: z.string().nullable(),
  documents: z.array(documentRefSchema),
  rev: z.number().int(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  cancellation: cancellationSchema,
});
export type Payment = z.infer<typeof paymentSchema>;

export const paymentListResponseSchema = z.object({
  items: z.array(paymentSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type PaymentListResponse = z.infer<typeof paymentListResponseSchema>;

export const paymentStatuses = ['UNPAID', 'PARTIAL', 'PAID'] as const;
export type PaymentStatus = (typeof paymentStatuses)[number];

// ---------------------------------------------------------------------------------------------
// M10 — Excel sync status (outbox monitoring; workbook processing needs separate authorisation)
// ---------------------------------------------------------------------------------------------

export const syncJobStatuses = [
  'PENDING',
  'LEASED',
  'DONE',
  'RETRY',
  'CONFLICT',
  'FAILED',
] as const;

export const syncJobQuerySchema = z
  .object({
    status: z.enum(syncJobStatuses).optional(),
    workbook: z.string().trim().max(50).optional(),
    page: pageSchema,
    pageSize: pageSizeSchema,
  })
  .strict();
export type SyncJobQuery = z.infer<typeof syncJobQuerySchema>;

export const syncJobSchema = z.object({
  id: z.string(),
  workbook: z.string(),
  sheet: z.string().nullable(),
  entity: z.object({ collection: z.string(), id: z.string(), code: z.string() }),
  entityRev: z.number().int(),
  operation: z.string(),
  status: z.enum(syncJobStatuses),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SyncJob = z.infer<typeof syncJobSchema>;

export const syncJobListResponseSchema = z.object({
  items: z.array(syncJobSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});

export const syncSummarySchema = z.object({
  processorEnabled: z.boolean(),
  processorNote: z.string(),
  byStatus: z.array(z.object({ status: z.enum(syncJobStatuses), count: z.number().int() })),
  byTarget: z.array(
    z.object({
      workbook: z.string(),
      sheet: z.string().nullable(),
      pending: z.number().int(),
      failed: z.number().int(),
      conflict: z.number().int(),
      done: z.number().int(),
    }),
  ),
  oldestPendingAt: z.string().nullable(),
});
export type SyncSummary = z.infer<typeof syncSummarySchema>;

// ---------------------------------------------------------------------------------------------
// M11 — Reports
// ---------------------------------------------------------------------------------------------

export const reportKeys = [
  'purchase-orders',
  'receipts',
  'stock',
  'dispatches',
  'payments',
  'demands',
  'vendors',
] as const;
export type ReportKey = (typeof reportKeys)[number];

export const reportQuerySchema = z
  .object({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    vendorId: objectIdStringSchema.optional(),
    itemId: objectIdStringSchema.optional(),
    provinceId: objectIdStringSchema.optional(),
    divisionId: objectIdStringSchema.optional(),
    warehouseId: objectIdStringSchema.optional(),
    includeCancelled: z.enum(['true', 'false']).default('false'),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .strict()
  .refine(dateRangeRefine, dateRangeMessage);
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const reportResponseSchema = z.object({
  key: z.enum(reportKeys),
  title: z.string(),
  generatedAt: z.string(),
  columns: z.array(
    z.object({ key: z.string(), label: z.string(), type: z.enum(['text', 'number', 'money']) }),
  ),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
  totals: z.record(z.string(), z.number()),
  /** True when the row limit cut the result; narrow the filters to see everything. */
  truncated: z.boolean(),
});
export type ReportResponse = z.infer<typeof reportResponseSchema>;
