import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger } from 'pino';

/** Paths that must never reach log output. */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.uri',
  '*.connectionString',
  'config.mongodb.uri',
  'mongodb.uri',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino(
    {
      level,
      base: { service: 'mab-pms-api' },
      redact: { paths: REDACTED_LOG_PATHS, censor: '[REDACTED]' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}
