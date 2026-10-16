import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import { connectToDatabase } from '../../src/db/mongo.js';
import {
  COLLECTIONS,
  ensureInfrastructureCollections,
  infrastructureCollections,
} from '../../src/db/collections.js';
import { silentLogger, testConfig } from '../helpers.js';
import { startReplicaSet, startStandalone } from './memoryMongo.js';

describe('database connection handling (in-memory MongoDB)', () => {
  describe('standalone server (no transactions)', () => {
    let server: MongoMemoryServer;
    beforeAll(async () => {
      server = await startStandalone();
    });
    afterAll(async () => {
      await server?.stop();
    });

    it('refuses to start when transactions are required', async () => {
      const config = testConfig({ MONGODB_URI: server.getUri() });
      await expect(connectToDatabase(config.mongodb, silentLogger)).rejects.toThrow(
        /does not support multi-document transactions/,
      );
    });

    it('connects in fallback mode only when explicitly allowed', async () => {
      const config = testConfig({
        MONGODB_URI: server.getUri(),
        MONGODB_REQUIRE_TRANSACTIONS: 'false',
      });
      const database = await connectToDatabase(config.mongodb, silentLogger);
      try {
        expect(database.supportsTransactions).toBe(false);
        expect(await database.ping()).toBe(true);
      } finally {
        await database.close();
      }
    });
  });

  describe('replica set', () => {
    let replSet: MongoMemoryReplSet;
    beforeAll(async () => {
      replSet = await startReplicaSet();
    });
    afterAll(async () => {
      await replSet?.stop();
    });

    it('detects transaction support and reports ping failures after close', async () => {
      const config = testConfig({ MONGODB_URI: replSet.getUri() });
      const database = await connectToDatabase(config.mongodb, silentLogger);
      expect(database.supportsTransactions).toBe(true);
      expect(await database.ping()).toBe(true);
      await database.close();
      expect(await database.ping()).toBe(false);
    });

    it('creates infrastructure collections, validators and indexes idempotently', async () => {
      const config = testConfig({
        MONGODB_URI: replSet.getUri(),
        MONGODB_DB_NAME: 'pms_schema_test',
      });
      const database = await connectToDatabase(config.mongodb, silentLogger);
      try {
        await ensureInfrastructureCollections(database.db);
        await ensureInfrastructureCollections(database.db); // second run must not fail

        const names = (await database.db.listCollections().toArray()).map((c) => c.name);
        for (const spec of infrastructureCollections) expect(names).toContain(spec.name);

        const syncIndexes = await database.db.collection(COLLECTIONS.syncJobs).indexes();
        expect(syncIndexes.find((i) => i.name === 'idempotencyKey_unique')?.unique).toBe(true);
        const rawIndexes = await database.db.collection(COLLECTIONS.rawSourceRows).indexes();
        expect(rawIndexes.find((i) => i.name === 'source_row_unique')?.unique).toBe(true);

        // Validators reject malformed documents written directly.
        await expect(
          database.db.collection(COLLECTIONS.auditEvents).insertOne({ action: 'DELETE' }),
        ).rejects.toThrow(/Document failed validation/);
        await expect(
          database.db.collection(COLLECTIONS.rawSourceRows).insertOne({ cells: [] }),
        ).rejects.toThrow(/Document failed validation/);
      } finally {
        await database.close();
      }
    });
  });
});
