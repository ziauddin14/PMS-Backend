import { z } from 'zod';
import { isLocalMongoUri } from './mongoUri.js';

const booleanFromString = z
  .enum(['true', 'false'], { message: 'must be "true" or "false"' })
  .transform((value) => value === 'true');

const originSchema = z.string().regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/, {
  message: 'each origin must look like https://host or http://host:port (no path, no "*")',
});

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    MONGODB_URI: z
      .string({ message: 'is required' })
      .min(1, { message: 'is required' })
      .refine((value) => /^mongodb(\+srv)?:\/\//.test(value), {
        message: 'must start with mongodb:// or mongodb+srv://',
      }),
    MONGODB_DB_NAME: z
      .string({ message: 'is required' })
      .regex(/^[A-Za-z0-9_-]{1,38}$/, { message: 'must be 1-38 letters, digits, "_" or "-"' }),
    MONGODB_ALLOW_REMOTE: booleanFromString.default(false),
    MONGODB_REQUIRE_TRANSACTIONS: booleanFromString.default(true),
    MONGODB_SERVER_SELECTION_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),

    CORS_ALLOWED_ORIGINS: z.string().optional(),
    REQUEST_BODY_LIMIT: z
      .string()
      .regex(/^\d{1,4}(b|kb|mb)$/, { message: 'must look like 100kb or 1mb' })
      .default('100kb'),
    TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
    RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100000).default(300),

    SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(5).max(1440).default(120),
    SESSION_COOKIE_SECURE: booleanFromString.optional(),
    SESSION_COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
    LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(86400000).default(900000),
    LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(20),
    LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).max(100).default(5),
    LOGIN_LOCKOUT_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
  })
  .superRefine((env, ctx) => {
    if (!env.MONGODB_ALLOW_REMOTE && env.MONGODB_URI && !isLocalMongoUri(env.MONGODB_URI)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MONGODB_URI'],
        message:
          'points to a non-local database; set MONGODB_ALLOW_REMOTE=true only when connecting to an authorised remote database',
      });
    }
    if (env.NODE_ENV === 'production') {
      if (!env.CORS_ALLOWED_ORIGINS?.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: 'is required in production',
        });
      }
      if (!env.MONGODB_REQUIRE_TRANSACTIONS) {
        ctx.addIssue({
          code: 'custom',
          path: ['MONGODB_REQUIRE_TRANSACTIONS'],
          message: 'must be true in production',
        });
      }
      if (env.SESSION_COOKIE_SECURE === false) {
        ctx.addIssue({
          code: 'custom',
          path: ['SESSION_COOKIE_SECURE'],
          message: 'must be true in production',
        });
      }
    }
    const secure = env.SESSION_COOKIE_SECURE ?? env.NODE_ENV === 'production';
    if (env.SESSION_COOKIE_SAMESITE === 'none' && !secure) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_COOKIE_SAMESITE'],
        message: '"none" requires SESSION_COOKIE_SECURE=true',
      });
    }
    if (env.SESSION_IDLE_MINUTES > env.SESSION_TTL_HOURS * 60) {
      ctx.addIssue({
        code: 'custom',
        path: ['SESSION_IDLE_MINUTES'],
        message: 'must not exceed SESSION_TTL_HOURS',
      });
    }
  });

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  mongodb: {
    uri: string;
    dbName: string;
    allowRemote: boolean;
    requireTransactions: boolean;
    serverSelectionTimeoutMs: number;
  };
  http: {
    corsAllowedOrigins: string[];
    bodyLimit: string;
    trustProxy: number;
    rateLimitWindowMs: number;
    rateLimitMax: number;
  };
  auth: {
    sessionTtlMs: number;
    sessionIdleMs: number;
    cookieSecure: boolean;
    cookieSameSite: 'lax' | 'strict' | 'none';
    loginRateLimitWindowMs: number;
    loginRateLimitMax: number;
    maxFailedLogins: number;
    lockoutMs: number;
  };
}

/**
 * Thrown when configuration is invalid. The message names the variables and the rule
 * they broke; it never contains the values supplied.
 */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const DEV_DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const name = issue.path.join('.') || '(environment)';
      // Only our own messages or zod's type/range descriptions are used; zod does not echo
      // input values in these messages.
      return `${name}: ${issue.message}`;
    });
    throw new ConfigError(problems);
  }
  const values = parsed.data;

  const originsRaw = values.CORS_ALLOWED_ORIGINS?.trim();
  const origins = originsRaw
    ? originsRaw
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : values.NODE_ENV === 'production'
      ? []
      : DEV_DEFAULT_ORIGINS;
  const badOrigins = origins.filter((origin) => !originSchema.safeParse(origin).success);
  if (badOrigins.length > 0) {
    throw new ConfigError([
      `CORS_ALLOWED_ORIGINS: ${badOrigins.length} invalid entr${badOrigins.length === 1 ? 'y' : 'ies'}; each origin must look like https://host or http://host:port (no path, no "*")`,
    ]);
  }

  return {
    nodeEnv: values.NODE_ENV,
    host: values.HOST,
    port: values.PORT,
    logLevel: values.LOG_LEVEL,
    mongodb: {
      uri: values.MONGODB_URI,
      dbName: values.MONGODB_DB_NAME,
      allowRemote: values.MONGODB_ALLOW_REMOTE,
      requireTransactions: values.MONGODB_REQUIRE_TRANSACTIONS,
      serverSelectionTimeoutMs: values.MONGODB_SERVER_SELECTION_TIMEOUT_MS,
    },
    http: {
      corsAllowedOrigins: origins,
      bodyLimit: values.REQUEST_BODY_LIMIT,
      trustProxy: values.TRUST_PROXY,
      rateLimitWindowMs: values.RATE_LIMIT_WINDOW_MS,
      rateLimitMax: values.RATE_LIMIT_MAX,
    },
    auth: {
      sessionTtlMs: values.SESSION_TTL_HOURS * 3_600_000,
      sessionIdleMs: values.SESSION_IDLE_MINUTES * 60_000,
      cookieSecure: values.SESSION_COOKIE_SECURE ?? values.NODE_ENV === 'production',
      cookieSameSite: values.SESSION_COOKIE_SAMESITE,
      loginRateLimitWindowMs: values.LOGIN_RATE_LIMIT_WINDOW_MS,
      loginRateLimitMax: values.LOGIN_RATE_LIMIT_MAX,
      maxFailedLogins: values.LOGIN_MAX_FAILURES,
      lockoutMs: values.LOGIN_LOCKOUT_MINUTES * 60_000,
    },
  };
}
