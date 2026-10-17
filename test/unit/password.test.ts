import { describe, expect, it } from 'vitest';
import {
  checkPasswordPolicy,
  getDummyHash,
  hashPassword,
  PASSWORD_HASH_PATTERN,
  verifyPassword,
} from '../../src/auth/password.js';

const SYNTHETIC_PASSWORD = 'synthetic-correct-horse-42';

describe('password hashing', () => {
  it('hashes with scrypt and a random salt', async () => {
    const a = await hashPassword(SYNTHETIC_PASSWORD);
    const b = await hashPassword(SYNTHETIC_PASSWORD);
    expect(a).toMatch(PASSWORD_HASH_PATTERN);
    expect(a.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain(SYNTHETIC_PASSWORD);
  });

  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword(SYNTHETIC_PASSWORD);
    expect(await verifyPassword(SYNTHETIC_PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('synthetic-wrong-password', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('rejects malformed stored hashes without throwing', async () => {
    expect(await verifyPassword(SYNTHETIC_PASSWORD, 'not-a-hash')).toBe(false);
    expect(await verifyPassword(SYNTHETIC_PASSWORD, 'bcrypt$1$2$3$4$5')).toBe(false);
  });

  it('provides a stable dummy hash for unknown users', async () => {
    const dummy = await getDummyHash();
    expect(dummy).toMatch(PASSWORD_HASH_PATTERN);
    expect(await getDummyHash()).toBe(dummy);
    expect(await verifyPassword(SYNTHETIC_PASSWORD, dummy)).toBe(false);
  });
});

describe('password policy', () => {
  it('accepts a long passphrase', () => {
    expect(checkPasswordPolicy('synthetic passphrase 2026', 'tester')).toEqual([]);
  });

  it('rejects short, padded, username-containing and repeated passwords', () => {
    expect(checkPasswordPolicy('short', 'tester')).toHaveLength(1);
    expect(checkPasswordPolicy(' leading-space-pass', 'tester')).toHaveLength(1);
    expect(checkPasswordPolicy('my-tester-password', 'tester')).toHaveLength(1);
    expect(checkPasswordPolicy('aaaaaaaaaaaaaaaa', 'tester')).toHaveLength(1);
    expect(checkPasswordPolicy('x'.repeat(129), 'tester').length).toBeGreaterThanOrEqual(1);
  });
});
