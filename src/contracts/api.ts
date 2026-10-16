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
