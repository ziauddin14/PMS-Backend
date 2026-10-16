import { describe, expect, it } from 'vitest';
import type { Database } from '../../src/db/mongo.js';
import { ValidationError } from '../../src/errors.js';
import { RecordStore } from '../../src/records/recordStore.js';
import { syntheticWidgets, testActor } from '../helpers.js';

/**
 * Unit tests with a fake database that fails on any access. They prove that invalid input is
 * rejected BEFORE anything touches MongoDB. Real persistence is covered by the integration tests.
 */
function storeWithUntouchableDatabase(): RecordStore {
  const fail = () => {
    throw new Error('database must not be touched');
  };
  const fake = {
    supportsTransactions: true,
    client: new Proxy({}, { get: fail }),
    db: new Proxy({}, { get: fail }),
    ping: fail,
    close: fail,
  } as unknown as Database;
  return new RecordStore(fake);
}

const ctx = { actor: testActor };

describe('RecordStore input validation (no database)', () => {
  const store = storeWithUntouchableDatabase();

  it('rejects invalid field values', async () => {
    await expect(
      store.create(syntheticWidgets, { name: '', quantity: -1 }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects unknown fields and non-object input', async () => {
    await expect(
      store.create(syntheticWidgets, { name: 'X', quantity: 1, extra: true }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(store.create(syntheticWidgets, null, ctx)).rejects.toBeInstanceOf(ValidationError);
    await expect(store.create(syntheticWidgets, [1, 2], ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('rejects system-managed fields', async () => {
    for (const field of ['_id', 'code', 'rev', 'createdAt', 'lifecycle', 'provenance']) {
      const error = await store
        .create(syntheticWidgets, { name: 'X', quantity: 1, [field]: 'forged' }, ctx)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).details?.[0]?.path).toBe(field);
    }
  });

  it('requires a valid actor', async () => {
    await expect(
      store.create(syntheticWidgets, { name: 'X', quantity: 1 }, { actor: { type: 'USER' } }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.create(syntheticWidgets, { name: 'X', quantity: 1 }, {} as never),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects empty updates, bad revisions and blank archive reasons', async () => {
    await expect(store.update(syntheticWidgets, 'a'.repeat(24), 1, {}, ctx)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      store.update(syntheticWidgets, 'a'.repeat(24), 0, { quantity: 1 }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      store.archive(syntheticWidgets, 'a'.repeat(24), 1, '   ', ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('exposes no hard-delete operation', () => {
    const methods = Object.getOwnPropertyNames(RecordStore.prototype);
    expect(methods).not.toEqual(expect.arrayContaining(['delete']));
    expect(methods.some((m) => /delete|remove|drop/i.test(m))).toBe(false);
  });
});
