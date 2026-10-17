/**
 * Local development only: runs the API against a throw-away in-memory MongoDB replica set and
 * creates two synthetic demo accounts with random one-time passwords printed to this terminal.
 * Nothing is persisted; everything disappears when the process stops.
 *
 *   npm run dev:memory
 */
import { randomBytes } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

if ((process.env.NODE_ENV ?? 'development') !== 'development') {
  process.stderr.write('dev:memory runs only with NODE_ENV=development.\n');
  process.exit(1);
}

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
});
process.env.NODE_ENV = 'development';
process.env.MONGODB_URI = replSet.getUri();
process.env.MONGODB_DB_NAME = process.env.MONGODB_DB_NAME ?? 'pms_dev_memory';
process.env.MONGODB_ALLOW_REMOTE = 'false';

const { loadConfig } = await import('../src/config/env.js');
const { connectToDatabase } = await import('../src/db/mongo.js');
const { ensureInfrastructureCollections } = await import('../src/db/collections.js');
const { ensureAuthCollections } = await import('../src/auth/collections.js');
const { AuthService } = await import('../src/auth/authService.js');
const { UserAdmin } = await import('../src/auth/userAdmin.js');
const { RecordStore } = await import('../src/records/recordStore.js');
const { createLogger } = await import('../src/logger.js');

const config = loadConfig(process.env);
const database = await connectToDatabase(config.mongodb, createLogger('warn'));
await ensureInfrastructureCollections(database.db);
await ensureAuthCollections(database.db);
const auth = new AuthService(database, config.auth);
const admin = new UserAdmin(
  database.db,
  new RecordStore(database),
  { type: 'SYSTEM', label: 'dev:memory' },
  (id) => auth.revokeAllSessions(id),
);

const accounts = [
  { username: 'demo.operator', displayName: 'Demo Operator', role: 'OPERATOR' as const },
  { username: 'demo.viewer', displayName: 'Demo Viewer (HOD)', role: 'VIEWER' as const },
];
const lines: string[] = [];
for (const account of accounts) {
  const password = `${randomBytes(12).toString('base64url')}-dev`;
  await admin.create({ ...account, password });
  lines.push(`  ${account.username.padEnd(15)} ${account.role.padEnd(9)} password: ${password}`);
}
await database.close();

process.stdout.write(
  [
    '',
    '=== In-memory development database (data is lost when this process stops) ===',
    'Synthetic demo accounts for this run only:',
    ...lines,
    '',
  ].join('\n'),
);

const stop = () => {
  void replSet.stop().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

await import('../src/server.js');
