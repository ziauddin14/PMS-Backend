import { Writable } from 'node:stream';
import { z } from 'zod';
import { loadConfig, type AppConfig } from '../src/config/env.js';
import { createLogger, type Logger } from '../src/logger.js';
import type { RecordDefinition } from '../src/records/recordStore.js';
import type { Actor } from '../src/domain/context.js';

/** Builds a test configuration from a minimal synthetic environment. */
export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://127.0.0.1:27017',
    MONGODB_DB_NAME: 'pms_test',
    LOG_LEVEL: 'silent',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    ...env,
  });
}

export const silentLogger: Logger = createLogger('silent');

/** A logger that captures every line, for checking that secrets never reach the log. */
export function capturingLogger(level = 'trace'): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { logger: createLogger(level, stream), lines };
}

export const testActor: Actor = { type: 'USER', id: 'synthetic-user-1', label: 'Synthetic Tester' };

/** Synthetic record type used only by tests — not a business entity. */
const widgetCreate = z
  .object({
    name: z.string().min(1).max(100),
    quantity: z.number().int().min(0),
  })
  .strict();
const widgetUpdate = widgetCreate.partial().strict();

export const syntheticWidgets: RecordDefinition<
  z.infer<typeof widgetCreate>,
  z.infer<typeof widgetUpdate>
> = {
  collection: 'synthetic_widgets',
  codePrefix: 'TST',
  createSchema: widgetCreate,
  updateSchema: widgetUpdate,
  syncTargets: [{ workbook: 'SYNTHETIC_WORKBOOK', sheet: 'Synthetic Sheet' }],
};
