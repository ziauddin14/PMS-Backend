import { z } from 'zod';

/** Liveness response of `GET /api/health`. Contains no configuration or secrets. */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('mab-pms-api'),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Readiness response of `GET /api/health/ready`. */
export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.object({
    database: z.enum(['up', 'down']),
  }),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

/** Error codes the API may return. Messages are safe to show; they never contain secrets. */
export const apiErrorCodes = [
  'VALIDATION_FAILED',
  'BAD_REQUEST',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'FORBIDDEN_ORIGIN',
  'RATE_LIMITED',
  'SERVICE_UNAVAILABLE',
  'INTERNAL_ERROR',
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'FORBIDDEN',
  'CSRF_FAILED',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
] as const;
export type ApiErrorCode = (typeof apiErrorCodes)[number];

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum(apiErrorCodes),
    message: z.string(),
    requestId: z.string().optional(),
    details: z
      .array(
        z.object({
          path: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;

/** Roles from M1: the Production Operator does operational work; HOD and managers are read-only. */
export const userRoles = ['OPERATOR', 'VIEWER'] as const;
export type UserRole = (typeof userRoles)[number];

export const loginRequestSchema = z
  .object({
    username: z
      .string({ message: 'Username is required' })
      .trim()
      .min(1, { message: 'Username is required' })
      .max(50, { message: 'Username is too long' }),
    password: z
      .string({ message: 'Password is required' })
      .min(1, { message: 'Password is required' })
      .max(128, { message: 'Password is too long' }),
  })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const sessionUserSchema = z.object({
  id: z.string(),
  code: z.string(),
  username: z.string(),
  displayName: z.string(),
  role: z.enum(userRoles),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

/** Body of `POST /api/auth/login` and `GET /api/auth/session`. The session token itself is only in an HttpOnly cookie. */
export const sessionResponseSchema = z.object({
  user: sessionUserSchema,
  csrfToken: z.string(),
  expiresAt: z.string(),
  idleExpiresAt: z.string(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/**
 * `GET /api/dashboard/summary`. Indicators whose module is not built yet are reported as
 * `not_available` with the milestone that will provide them — never with invented figures.
 */
export const dashboardIndicatorSchema = z.object({
  key: z.string(),
  label: z.string(),
  description: z.string(),
  status: z.enum(['available', 'not_available']),
  value: z.number().nullable(),
  plannedMilestone: z.string().nullable(),
});
export type DashboardIndicator = z.infer<typeof dashboardIndicatorSchema>;

export const dashboardSummarySchema = z.object({
  generatedAt: z.string(),
  user: sessionUserSchema,
  indicators: z.array(dashboardIndicatorSchema),
  system: z.object({
    database: z.enum(['up', 'down']),
  }),
});
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

/**
 * Master data (M4). Entities from BRD Module 2 (vendors, items, provinces, divisions,
 * departments) and M1 field mapping (warehouses). Records are deactivated, never deleted.
 */
export const masterEntityKeys = [
  'provinces',
  'divisions',
  'departments',
  'items',
  'vendors',
  'warehouses',
] as const;
export type MasterEntityKey = (typeof masterEntityKeys)[number];

export const masterNameSchema = z
  .string({ message: 'Name is required' })
  .trim()
  .min(1, { message: 'Name is required' })
  .max(100, { message: 'Name must be at most 100 characters' })
  .refine((value) => !/\p{Cc}/u.test(value), { message: 'Name contains invalid characters' });

export const objectIdStringSchema = z
  .string({ message: 'Is required' })
  .regex(/^[a-f0-9]{24}$/, { message: 'Must be a valid record id' });

export const masterRecordSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
  rev: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Divisions only. */
  provinceId: z.string().optional(),
  provinceName: z.string().optional(),
});
export type MasterRecord = z.infer<typeof masterRecordSchema>;

export const masterListResponseSchema = z.object({
  items: z.array(masterRecordSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type MasterListResponse = z.infer<typeof masterListResponseSchema>;

export const masterListQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(['active', 'inactive', 'all']).default('active'),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
    provinceId: objectIdStringSchema.optional(),
  })
  .strict();
export type MasterListQuery = z.infer<typeof masterListQuerySchema>;

export const masterCreateSchema = z
  .object({ name: masterNameSchema, provinceId: objectIdStringSchema.optional() })
  .strict();
export type MasterCreateInput = z.infer<typeof masterCreateSchema>;

export const masterUpdateSchema = z
  .object({
    rev: z.number({ message: 'rev is required' }).int().min(1),
    name: masterNameSchema.optional(),
    provinceId: objectIdStringSchema.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.provinceId !== undefined || v.active !== undefined, {
    message: 'Nothing to update',
  });
export type MasterUpdateInput = z.infer<typeof masterUpdateSchema>;

/**
 * Demand management (M5). Fields follow M1 BRD Step 2 and 02 §2.1: a demand has a date,
 * department, requesting province (optional division) and a source reference (e-mail subject);
 * each line is an item for one destination division (A-04) with a requested quantity and optional
 * receiver contact. The PMS code (DMD-000001) is the unique Demand Number (D1).
 */
export const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const dateOnlySchema = z
  .string({ message: 'Date is required' })
  .regex(DATE_ONLY_PATTERN, { message: 'Use the format YYYY-MM-DD' })
  .refine(
    (value) => {
      const date = new Date(`${value}T00:00:00Z`);
      return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
    },
    { message: 'Not a valid date' },
  );

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { message: `${label} must be at most ${max} characters` })
    .refine((value) => !/\p{Cc}/u.test(value), { message: `${label} contains invalid characters` })
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional();

export const demandLineInputSchema = z
  .object({
    /** Present for existing lines when editing; absent for new lines. */
    id: objectIdStringSchema.optional(),
    itemId: objectIdStringSchema,
    destinationDivisionId: objectIdStringSchema,
    quantity: z
      .number({ message: 'Quantity is required' })
      .int({ message: 'Quantity must be a whole number' })
      .min(1, { message: 'Quantity must be at least 1' })
      .max(10_000_000, { message: 'Quantity is too large' }),
    receiverName: optionalText(100, 'Receiver name'),
    receiverPhone: optionalText(30, 'Receiver phone').refine(
      (value) => value === null || value === undefined || /^[0-9+()\-\s]{5,30}$/.test(value),
      { message: 'Receiver phone may contain only digits, spaces, +, - and brackets' },
    ),
  })
  .strict();
export type DemandLineInput = z.infer<typeof demandLineInputSchema>;

const linesSchema = z
  .array(demandLineInputSchema)
  .min(1, { message: 'Add at least one item' })
  .max(200, { message: 'A demand can have at most 200 lines' });

export const demandCreateSchema = z
  .object({
    demandDate: dateOnlySchema,
    departmentId: objectIdStringSchema,
    provinceId: objectIdStringSchema,
    divisionId: objectIdStringSchema.nullable().optional(),
    sourceReference: optionalText(200, 'Source reference'),
    lines: linesSchema,
  })
  .strict();
export type DemandCreateInput = z.infer<typeof demandCreateSchema>;

export const demandUpdateSchema = z
  .object({
    rev: z.number({ message: 'rev is required' }).int().min(1),
    demandDate: dateOnlySchema.optional(),
    departmentId: objectIdStringSchema.optional(),
    provinceId: objectIdStringSchema.optional(),
    divisionId: objectIdStringSchema.nullable().optional(),
    sourceReference: optionalText(200, 'Source reference'),
    lines: linesSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((key) => key !== 'rev'), { message: 'Nothing to update' });
export type DemandUpdateInput = z.infer<typeof demandUpdateSchema>;

export const demandCancelSchema = z
  .object({
    rev: z.number({ message: 'rev is required' }).int().min(1),
    reason: z
      .string({ message: 'Reason is required' })
      .trim()
      .min(1, { message: 'Reason is required' })
      .max(500, { message: 'Reason must be at most 500 characters' }),
  })
  .strict();
export type DemandCancelInput = z.infer<typeof demandCancelSchema>;

export const demandSorts = ['demandDate_desc', 'demandDate_asc', 'code_desc', 'code_asc'] as const;

export const demandListQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(['open', 'cancelled', 'all']).default('open'),
    departmentId: objectIdStringSchema.optional(),
    provinceId: objectIdStringSchema.optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    sort: z.enum(demandSorts).default('demandDate_desc'),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  });
export type DemandListQuery = z.infer<typeof demandListQuerySchema>;

export const masterRefSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  active: z.boolean(),
});
export type MasterRef = z.infer<typeof masterRefSchema>;

/** Derived from dispatch lines (M8). Until dispatches exist every open line is PENDING. */
export const fulfilmentStatuses = ['PENDING', 'PARTIAL', 'DELIVERED'] as const;

export const demandSummarySchema = z.object({
  id: z.string(),
  code: z.string(),
  demandDate: z.string(),
  status: z.enum(['OPEN', 'CANCELLED']),
  fulfilment: z.enum(fulfilmentStatuses),
  department: masterRefSchema,
  province: masterRefSchema,
  division: masterRefSchema.nullable(),
  sourceReference: z.string().nullable(),
  lineCount: z.number().int(),
  totalQuantity: z.number().int(),
  rev: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DemandSummary = z.infer<typeof demandSummarySchema>;

export const demandLineSchema = z.object({
  id: z.string(),
  lineNo: z.number().int(),
  item: masterRefSchema,
  destinationDivision: masterRefSchema.extend({ provinceName: z.string().nullable() }),
  quantity: z.number().int(),
  quantityDelivered: z.number().int(),
  quantityRemaining: z.number().int(),
  fulfilment: z.enum(fulfilmentStatuses),
  /** Personal data: omitted for read-only users (Q-30 open; most restrictive default). */
  receiverName: z.string().nullable().optional(),
  receiverPhone: z.string().nullable().optional(),
});
export type DemandLine = z.infer<typeof demandLineSchema>;

export const demandDetailSchema = demandSummarySchema.extend({
  lines: z.array(demandLineSchema),
  cancellation: z
    .object({ at: z.string(), reason: z.string(), by: z.string().nullable() })
    .nullable(),
  personalDataVisible: z.boolean(),
});
export type DemandDetail = z.infer<typeof demandDetailSchema>;

export const demandListResponseSchema = z.object({
  items: z.array(demandSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type DemandListResponse = z.infer<typeof demandListResponseSchema>;

/**
 * Purchase Order Management (M6).
 * POs manage vendor purchasing, delivery routes (warehouse or direct), approved amounts,
 * payment schedules, and one complete invoice per PO.
 */
export const deliveryRoutes = ['WAREHOUSE', 'DIRECT'] as const;
export type DeliveryRoute = (typeof deliveryRoutes)[number];
export const deliveryRouteSchema = z.enum(deliveryRoutes);

export const poCompletionStatuses = ['PENDING', 'PARTIAL', 'COMPLETE'] as const;
export type PoCompletionStatus = (typeof poCompletionStatuses)[number];
export const poCompletionStatusSchema = z.enum(poCompletionStatuses);

export const paymentScheduleEntryInputSchema = z
  .object({
    entryNo: z.number().int().min(1).optional(),
    dueDate: dateOnlySchema,
    plannedAmount: z
      .number({ message: 'Planned amount is required' })
      .positive({ message: 'Planned amount must be greater than 0' }),
    note: optionalText(200, 'Schedule note'),
  })
  .strict();
export type PaymentScheduleEntryInput = z.infer<typeof paymentScheduleEntryInputSchema>;

export const invoiceInputSchema = z
  .object({
    invoiceNo: optionalText(50, 'Invoice number'),
    invoiceDate: dateOnlySchema.nullable().optional(),
    invoiceAmount: z
      .number()
      .min(0, { message: 'Invoice amount cannot be negative' })
      .nullable()
      .optional(),
    notes: optionalText(500, 'Invoice notes'),
  })
  .strict();
export type InvoiceInput = z.infer<typeof invoiceInputSchema>;

export const purchaseOrderLineInputSchema = z
  .object({
    id: objectIdStringSchema.optional(),
    itemId: objectIdStringSchema,
    demandId: objectIdStringSchema.nullable().optional(),
    demandLineId: objectIdStringSchema.nullable().optional(),
    quantityOrdered: z
      .number({ message: 'Quantity is required' })
      .int({ message: 'Quantity must be a whole number' })
      .min(1, { message: 'Quantity must be at least 1' })
      .max(10_000_000, { message: 'Quantity is too large' }),
    unitPrice: z
      .number({ message: 'Unit price is required' })
      .min(0, { message: 'Unit price cannot be negative' }),
    notes: optionalText(500, 'Line note'),
  })
  .strict();
export type PurchaseOrderLineInput = z.infer<typeof purchaseOrderLineInputSchema>;

const poLinesSchema = z
  .array(purchaseOrderLineInputSchema)
  .min(1, { message: 'Add at least one line' })
  .max(200, { message: 'A purchase order can have at most 200 lines' });

export const purchaseOrderCreateSchema = z
  .object({
    poNumber: z
      .string({ message: 'PO number is required' })
      .trim()
      .min(1, { message: 'PO number is required' })
      .max(50, { message: 'PO number must be at most 50 characters' })
      .refine((val) => !/\p{Cc}/u.test(val), { message: 'PO number contains invalid characters' }),
    poDate: dateOnlySchema,
    vendorId: objectIdStringSchema,
    deliveryRoute: deliveryRouteSchema,
    targetWarehouseId: objectIdStringSchema.nullable().optional(),
    destinationDivisionId: objectIdStringSchema.nullable().optional(),
    approvedAmount: z
      .number({ message: 'Approved amount is required' })
      .min(0, { message: 'Approved amount cannot be negative' }),
    expectedCompletionDate: dateOnlySchema.nullable().optional(),
    notes: optionalText(1000, 'Notes'),
    invoice: invoiceInputSchema.nullable().optional(),
    paymentSchedule: z.array(paymentScheduleEntryInputSchema).optional().default([]),
    lines: poLinesSchema,
  })
  .strict();
export type PurchaseOrderCreateInput = z.infer<typeof purchaseOrderCreateSchema>;

export const purchaseOrderUpdateSchema = z
  .object({
    rev: z.number({ message: 'rev is required' }).int().min(1),
    poNumber: z
      .string()
      .trim()
      .min(1, { message: 'PO number is required' })
      .max(50, { message: 'PO number must be at most 50 characters' })
      .refine((val) => !/\p{Cc}/u.test(val), { message: 'PO number contains invalid characters' })
      .optional(),
    poDate: dateOnlySchema.optional(),
    vendorId: objectIdStringSchema.optional(),
    deliveryRoute: deliveryRouteSchema.optional(),
    targetWarehouseId: objectIdStringSchema.nullable().optional(),
    destinationDivisionId: objectIdStringSchema.nullable().optional(),
    approvedAmount: z.number().min(0, { message: 'Approved amount cannot be negative' }).optional(),
    expectedCompletionDate: dateOnlySchema.nullable().optional(),
    notes: optionalText(1000, 'Notes'),
    invoice: invoiceInputSchema.nullable().optional(),
    paymentSchedule: z.array(paymentScheduleEntryInputSchema).optional(),
    lines: poLinesSchema.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((key) => key !== 'rev'), { message: 'Nothing to update' });
export type PurchaseOrderUpdateInput = z.infer<typeof purchaseOrderUpdateSchema>;

export const purchaseOrderCancelSchema = z
  .object({
    rev: z.number({ message: 'rev is required' }).int().min(1),
    reason: z
      .string({ message: 'Reason is required' })
      .trim()
      .min(1, { message: 'Reason is required' })
      .max(500, { message: 'Reason must be at most 500 characters' }),
  })
  .strict();
export type PurchaseOrderCancelInput = z.infer<typeof purchaseOrderCancelSchema>;

export const purchaseOrderSorts = [
  'poDate_desc',
  'poDate_asc',
  'code_desc',
  'code_asc',
  'poNumber_desc',
  'poNumber_asc',
] as const;
export type PurchaseOrderSort = (typeof purchaseOrderSorts)[number];

export const purchaseOrderListQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(['open', 'cancelled', 'all']).default('open'),
    vendorId: objectIdStringSchema.optional(),
    deliveryRoute: deliveryRouteSchema.optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    sort: z.enum(purchaseOrderSorts).default('poDate_desc'),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  });
export type PurchaseOrderListQuery = z.infer<typeof purchaseOrderListQuerySchema>;

export const paymentScheduleEntrySchema = z.object({
  entryNo: z.number().int(),
  dueDate: z.string(),
  plannedAmount: z.number(),
  note: z.string().nullable(),
});
export type PaymentScheduleEntry = z.infer<typeof paymentScheduleEntrySchema>;

export const invoiceMetaSchema = z.object({
  invoiceNo: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  invoiceAmount: z.number().nullable(),
  notes: z.string().nullable(),
});
export type InvoiceMeta = z.infer<typeof invoiceMetaSchema>;

export const poDemandRefSchema = z.object({
  id: z.string(),
  code: z.string(),
  demandDate: z.string(),
  lineNo: z.number().int().nullable(),
});
export type PoDemandRef = z.infer<typeof poDemandRefSchema>;

export const purchaseOrderLineSchema = z.object({
  id: z.string(),
  lineNo: z.number().int(),
  item: masterRefSchema,
  demand: poDemandRefSchema.nullable(),
  quantityOrdered: z.number().int(),
  quantityReceived: z.number().int(),
  quantityRemaining: z.number().int(),
  unitPrice: z.number(),
  lineTotal: z.number(),
  notes: z.string().nullable(),
  completion: poCompletionStatusSchema,
});
export type PurchaseOrderLine = z.infer<typeof purchaseOrderLineSchema>;

export const purchaseOrderSummarySchema = z.object({
  id: z.string(),
  code: z.string(),
  poNumber: z.string(),
  poDate: z.string(),
  status: z.enum(['OPEN', 'CANCELLED']),
  completion: poCompletionStatusSchema,
  vendor: masterRefSchema,
  deliveryRoute: deliveryRouteSchema,
  targetWarehouse: masterRefSchema.nullable(),
  destinationDivision: masterRefSchema.extend({ provinceName: z.string().nullable() }).nullable(),
  approvedAmount: z.number(),
  totalAmount: z.number(),
  lineCount: z.number().int(),
  totalQuantity: z.number().int(),
  expectedCompletionDate: z.string().nullable(),
  rev: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PurchaseOrderSummary = z.infer<typeof purchaseOrderSummarySchema>;

export const purchaseOrderDetailSchema = purchaseOrderSummarySchema.extend({
  notes: z.string().nullable(),
  invoice: invoiceMetaSchema.nullable(),
  paymentSchedule: z.array(paymentScheduleEntrySchema),
  lines: z.array(purchaseOrderLineSchema),
  cancellation: z
    .object({ at: z.string(), reason: z.string(), by: z.string().nullable() })
    .nullable(),
});
export type PurchaseOrderDetail = z.infer<typeof purchaseOrderDetailSchema>;

export const purchaseOrderListResponseSchema = z.object({
  items: z.array(purchaseOrderSummarySchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type PurchaseOrderListResponse = z.infer<typeof purchaseOrderListResponseSchema>;
