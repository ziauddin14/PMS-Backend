import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';

/** Single-node replica set: supports multi-document transactions, like Atlas. */
export async function startReplicaSet(): Promise<MongoMemoryReplSet> {
  return MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
}

/** Standalone server: no transactions, used to test the non-atomic fallback. */
export async function startStandalone(): Promise<MongoMemoryServer> {
  return MongoMemoryServer.create();
}
