import type { Db } from 'mongodb';
import { ensureCollection, recordCollectionSpec, type CollectionSpec } from '../db/collections.js';

export const AUTH_COLLECTIONS = {
  users: 'users',
  sessions: 'sessions',
  loginThrottle: 'loginThrottle',
  authEvents: 'authEvents',
} as const;

/** Users are operational records (code, rev, lifecycle, audit) written through RecordStore. */
export const usersCollectionSpec: CollectionSpec = recordCollectionSpec(AUTH_COLLECTIONS.users, {
  required: ['username', 'displayName', 'role', 'passwordHash'],
  properties: {
    username: { bsonType: 'string', pattern: '^[a-z0-9._-]{3,50}$' },
    displayName: { bsonType: 'string', minLength: 1, maxLength: 100 },
    role: { enum: ['OPERATOR', 'VIEWER'] },
    passwordHash: { bsonType: 'string', pattern: '^scrypt\\$' },
  },
  indexes: [{ key: { username: 1 }, name: 'username_unique', unique: true }],
});

/**
 * Server-side sessions. `_id` is the SHA-256 of the session token; the raw token exists only in
 * the user's HttpOnly cookie. Expired sessions are removed by a TTL index.
 */
export const sessionsCollectionSpec: CollectionSpec = {
  name: AUTH_COLLECTIONS.sessions,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: [
        '_id',
        'userId',
        'csrfToken',
        'createdAt',
        'lastSeenAt',
        'expiresAt',
        'idleExpiresAt',
      ],
      properties: {
        _id: { bsonType: 'string', pattern: '^[a-f0-9]{64}$' },
        userId: { bsonType: 'objectId' },
        csrfToken: { bsonType: 'string', minLength: 32 },
        createdAt: { bsonType: 'date' },
        lastSeenAt: { bsonType: 'date' },
        expiresAt: { bsonType: 'date' },
        idleExpiresAt: { bsonType: 'date' },
        userAgent: { bsonType: ['string', 'null'] },
      },
    },
  },
  indexes: [
    { key: { expiresAt: 1 }, name: 'expiresAt_ttl', expireAfterSeconds: 0 },
    { key: { userId: 1 }, name: 'userId' },
  ],
};

/**
 * Failed-login counters, used for temporary lockout. `_id` is `u:` + SHA-256 of the attempted
 * username (never the typed text itself). Removed by TTL.
 */
export const loginThrottleCollectionSpec: CollectionSpec = {
  name: AUTH_COLLECTIONS.loginThrottle,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['_id', 'failures', 'expiresAt'],
      properties: {
        _id: { bsonType: 'string', pattern: '^u:[a-f0-9]{64}$' },
        failures: { bsonType: ['int', 'long'], minimum: 0 },
        lockedUntil: { bsonType: ['date', 'null'] },
        expiresAt: { bsonType: 'date' },
      },
    },
  },
  indexes: [{ key: { expiresAt: 1 }, name: 'expiresAt_ttl', expireAfterSeconds: 0 }],
};

/** Append-only security log: sign-ins, failures, lockouts, sign-outs. Never contains passwords. */
export const authEventsCollectionSpec: CollectionSpec = {
  name: AUTH_COLLECTIONS.authEvents,
  validator: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['occurredAt', 'type', 'username'],
      properties: {
        occurredAt: { bsonType: 'date' },
        type: {
          enum: [
            'LOGIN_SUCCEEDED',
            'LOGIN_FAILED',
            'ACCOUNT_LOCKED',
            'LOGOUT',
            'SESSION_EXPIRED',
            'LOCKOUT_CLEARED',
          ],
        },
        username: { bsonType: 'string', maxLength: 50 },
        userId: { bsonType: ['objectId', 'null'] },
        reason: { bsonType: ['string', 'null'] },
        requestId: { bsonType: ['string', 'null'] },
      },
    },
  },
  indexes: [
    { key: { occurredAt: -1 }, name: 'occurredAt' },
    { key: { username: 1, occurredAt: -1 }, name: 'username_occurredAt' },
  ],
};

export const authCollectionSpecs = [
  usersCollectionSpec,
  sessionsCollectionSpec,
  loginThrottleCollectionSpec,
  authEventsCollectionSpec,
];

export async function ensureAuthCollections(db: Db): Promise<void> {
  for (const spec of authCollectionSpecs) await ensureCollection(db, spec);
}
