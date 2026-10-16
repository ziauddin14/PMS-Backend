import { describe, expect, it } from 'vitest';
import { connectToDatabase, DatabaseConnectionError } from '../../src/db/mongo.js';
import { capturingLogger, testConfig } from '../helpers.js';

const SECRET = 'NeverLogThisPassword';

// No database server is needed: the driver is pointed at a closed local port.
describe('database connection failure handling', () => {
  it('fails with a safe error when the server is unreachable', async () => {
    const config = testConfig({
      MONGODB_URI: `mongodb://synthetic-user:${SECRET}@127.0.0.1:1/pms_test`,
      MONGODB_SERVER_SELECTION_TIMEOUT_MS: '300',
    });
    const { logger, lines } = capturingLogger();
    const error = await connectToDatabase(config.mongodb, logger).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DatabaseConnectionError);
    const message = (error as Error).message;
    expect(message).toContain('Could not connect to MongoDB');
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain('synthetic-user');
    expect(message).not.toContain('127.0.0.1');
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});
