import { MongoClient, type Db } from 'mongodb';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../logger.js';

/**
 * Thrown when the database cannot be used. The message is safe to log and show: it never
 * contains the connection string, credentials or host names.
 */
export class DatabaseConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConnectionError';
  }
}

export interface Database {
  client: MongoClient;
  db: Db;
  /** True when the deployment is a replica set or sharded cluster (multi-document transactions). */
  supportsTransactions: boolean;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export async function detectTransactionSupport(db: Db): Promise<boolean> {
  const hello = await db.admin().command({ hello: 1 });
  return Boolean(hello.setName) || hello.msg === 'isdbgrid';
}

export async function connectToDatabase(
  config: AppConfig['mongodb'],
  logger: Logger,
): Promise<Database> {
  const client = new MongoClient(config.uri, {
    appName: 'mab-pms-api',
    serverSelectionTimeoutMS: config.serverSelectionTimeoutMs,
  });

  try {
    await client.connect();
    const db = client.db(config.dbName);
    await db.command({ ping: 1 });
    const supportsTransactions = await detectTransactionSupport(db);

    if (config.requireTransactions && !supportsTransactions) {
      throw new DatabaseConnectionError(
        'The MongoDB deployment does not support multi-document transactions (a replica set is required). ' +
          'Set MONGODB_REQUIRE_TRANSACTIONS=false only for local standalone development.',
      );
    }
    if (!supportsTransactions) {
      logger.warn(
        'MongoDB transactions are not available: record, audit and sync-job writes are NOT atomic. ' +
          'Using the pending-audit fallback (development only).',
      );
    }
    logger.info({ dbName: config.dbName, supportsTransactions }, 'connected to MongoDB');

    return {
      client,
      db,
      supportsTransactions,
      async ping() {
        try {
          await db.command({ ping: 1 });
          return true;
        } catch {
          return false;
        }
      },
      close: () => client.close(),
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    if (error instanceof DatabaseConnectionError) throw error;
    // Driver messages can include host names; only the error class is reported.
    const kind = error instanceof Error ? error.name : 'UnknownError';
    throw new DatabaseConnectionError(
      `Could not connect to MongoDB (${kind}). Check MONGODB_URI, network access and that the database server is running.`,
    );
  }
}
