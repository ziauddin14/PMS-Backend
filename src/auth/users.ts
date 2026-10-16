import { z } from 'zod';
import { userRoles, type SessionUser } from '../contracts/api.js';
import type { RecordDefinition, StoredRecord } from '../records/recordStore.js';
import { PASSWORD_HASH_PATTERN } from './password.js';
import { AUTH_COLLECTIONS } from './collections.js';

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,50}$/;

const userCreateSchema = z
  .object({
    username: z
      .string()
      .regex(USERNAME_PATTERN, { message: 'Username must be 3-50 lowercase letters, digits, ".", "_" or "-"' }),
    displayName: z.string().trim().min(1).max(100),
    role: z.enum(userRoles),
    passwordHash: z.string().regex(PASSWORD_HASH_PATTERN, { message: 'Invalid password hash' }),
  })
  .strict();

const userUpdateSchema = userCreateSchema.omit({ username: true }).partial().strict();

export type UserFields = z.infer<typeof userCreateSchema>;
export type UserRecord = StoredRecord<UserFields>;

/** User accounts are stored as audited records; password hashes are redacted from the audit log. */
export const userDefinition: RecordDefinition<UserFields, z.infer<typeof userUpdateSchema>> = {
  collection: AUTH_COLLECTIONS.users,
  codePrefix: 'USR',
  createSchema: userCreateSchema,
  updateSchema: userUpdateSchema,
  auditRedactFields: ['passwordHash'],
};

export function normaliseUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function toSessionUser(user: UserRecord): SessionUser {
  return {
    id: user._id.toHexString(),
    code: user.code,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
  };
}
