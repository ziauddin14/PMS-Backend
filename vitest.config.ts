import { defineConfig } from 'vitest/config';

/**
 * Two kinds of API tests:
 * - test/unit:        no database server (mocks, fakes, or a closed port). Fast.
 * - test/integration: a real MongoDB started in memory by mongodb-memory-server
 *                     (the first run downloads a MongoDB binary).
 * Select with `npm run test:unit` / `npm run test:integration`; `npm test` runs both.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // In-memory MongoDB servers are started per file; run files one at a time to keep memory low.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 300_000,
  },
});
