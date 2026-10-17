import { createHash, randomBytes } from 'node:crypto';
import type { Collection, ObjectId } from 'mongodb';
import type { AppConfig } from '../config/env.js';
import type { Database } from '../db/mongo.js';
import { AppError } from '../errors.js';
import { AUTH_COLLECTIONS } from './collections.js';
import { getDummyHash, verifyPassword } from './password.js';
import { normaliseUsername, type UserRecord } from './users.js';

export interface SessionDoc {
  _id: string;
  userId: ObjectId;
  csrfToken: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  idleExpiresAt: Date;
  userAgent: string | null;
}

interface ThrottleDoc {
  _id: string;
  failures: number;
  lockedUntil: Date | null;
  expiresAt: Date;
}

export type AuthEventType =
  | 'LOGIN_SUCCEEDED'
  | 'LOGIN_FAILED'
  | 'ACCOUNT_LOCKED'
  | 'LOGOUT'
  | 'SESSION_EXPIRED'
  | 'LOCKOUT_CLEARED';

interface AuthEventDoc {
  occurredAt: Date;
  type: AuthEventType;
  username: string;
  userId: ObjectId | null;
  reason: string | null;
  requestId: string | null;
}

export interface AuthenticatedContext {
  user: UserRecord;
  session: SessionDoc;
}

export interface RequestMeta {
  requestId?: string;
  userAgent?: string;
}

export class InvalidCredentialsError extends AppError {
  constructor() {
    super(401, 'INVALID_CREDENTIALS', 'Invalid username or password');
  }
}

export class AccountLockedError extends AppError {
  constructor() {
    super(429, 'ACCOUNT_LOCKED', 'Too many failed sign-in attempts. Try again later.');
  }
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const TOUCH_INTERVAL_MS = 60_000;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Username/password authentication with server-side sessions stored in MongoDB.
 * - Passwords are verified with scrypt; unknown users are checked against a dummy hash so that
 *   response time does not reveal whether an account exists.
 * - The session token is random (256 bits) and only its SHA-256 is stored.
 * - Sessions have an absolute lifetime and an idle timeout.
 * - Repeated failures lock the attempted username temporarily (whether or not it exists).
 */
export class AuthService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig['auth'],
  ) {}

  private get users(): Collection<UserRecord> {
    return this.database.db.collection<UserRecord>(AUTH_COLLECTIONS.users);
  }
  private get sessions(): Collection<SessionDoc> {
    return this.database.db.collection<SessionDoc>(AUTH_COLLECTIONS.sessions);
  }
  private get throttle(): Collection<ThrottleDoc> {
    return this.database.db.collection<ThrottleDoc>(AUTH_COLLECTIONS.loginThrottle);
  }
  private get events(): Collection<AuthEventDoc> {
    return this.database.db.collection<AuthEventDoc>(AUTH_COLLECTIONS.authEvents);
  }

  async login(
    usernameInput: string,
    password: string,
    meta: RequestMeta = {},
  ): Promise<{ token: string; session: SessionDoc; user: UserRecord }> {
    const username = normaliseUsername(usernameInput).slice(0, 50);
    const key = throttleKey(username);
    const now = new Date();

    // The typed username is only ever stored if it is an existing account's name. Anything
    // else (a typo, or a password typed into the username field) is logged as "(unknown)".
    const user = await this.users.findOne({ username });
    const logName = user ? user.username : UNKNOWN_USERNAME;

    const throttle = await this.throttle.findOne({ _id: key });
    if (throttle?.lockedUntil && throttle.lockedUntil > now) {
      await this.record('LOGIN_FAILED', logName, user?._id ?? null, 'LOCKED', meta);
      throw new AccountLockedError();
    }

    const passwordOk = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
    const active = user?.lifecycle?.state === 'ACTIVE';

    if (!user || !passwordOk || !active) {
      const reason = !user ? 'UNKNOWN_USER' : !passwordOk ? 'BAD_PASSWORD' : 'ACCOUNT_DISABLED';
      await this.record('LOGIN_FAILED', logName, user?._id ?? null, reason, meta);
      const locked = await this.registerFailure(key, now);
      if (locked) {
        await this.record('ACCOUNT_LOCKED', logName, user?._id ?? null, null, meta);
        throw new AccountLockedError();
      }
      throw new InvalidCredentialsError();
    }

    await this.throttle.deleteOne({ _id: key });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMs);
    const session: SessionDoc = {
      _id: hashSessionToken(token),
      userId: user._id,
      csrfToken: randomBytes(32).toString('base64url'),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      idleExpiresAt: minDate(new Date(now.getTime() + this.config.sessionIdleMs), expiresAt),
      userAgent: meta.userAgent ? meta.userAgent.slice(0, 200) : null,
    };
    await this.sessions.insertOne(session);
    await this.record('LOGIN_SUCCEEDED', username, user._id, null, meta);
    return { token, session, user };
  }

  /**
   * Resolves a session token. Returns the user and session, `'expired'` for a session that timed
   * out (it is deleted), or `null` when the token is unknown or the account is no longer active.
   */
  async resolve(
    token: string,
    meta: RequestMeta = {},
  ): Promise<AuthenticatedContext | 'expired' | null> {
    if (!TOKEN_PATTERN.test(token)) return null;
    const id = hashSessionToken(token);
    const session = await this.sessions.findOne({ _id: id });
    if (!session) return null;

    const now = new Date();
    if (session.expiresAt <= now || session.idleExpiresAt <= now) {
      await this.sessions.deleteOne({ _id: id });
      const user = await this.users.findOne({ _id: session.userId });
      await this.record(
        'SESSION_EXPIRED',
        user?.username ?? '(unknown)',
        session.userId,
        null,
        meta,
      );
      return 'expired';
    }

    const user = await this.users.findOne({ _id: session.userId });
    if (!user || user.lifecycle?.state !== 'ACTIVE') {
      await this.sessions.deleteOne({ _id: id });
      return null;
    }

    if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
      const idleExpiresAt = minDate(
        new Date(now.getTime() + this.config.sessionIdleMs),
        session.expiresAt,
      );
      await this.sessions.updateOne({ _id: id }, { $set: { lastSeenAt: now, idleExpiresAt } });
      session.lastSeenAt = now;
      session.idleExpiresAt = idleExpiresAt;
    }
    return { user, session };
  }

  async logout(context: AuthenticatedContext, meta: RequestMeta = {}): Promise<void> {
    await this.sessions.deleteOne({ _id: context.session._id });
    await this.record('LOGOUT', context.user.username, context.user._id, null, meta);
  }

  /** Ends every session of a user (e.g. after a password reset or when an account is disabled). */
  async revokeAllSessions(userId: ObjectId): Promise<number> {
    const result = await this.sessions.deleteMany({ userId });
    return result.deletedCount;
  }

  /**
   * Administrator recovery for a locked account (used by `user-admin unlock`). Returns whether a
   * lockout or failure counter was cleared. Does not change the lockout rules themselves.
   */
  async clearLockout(usernameInput: string, meta: RequestMeta = {}): Promise<boolean> {
    const username = normaliseUsername(usernameInput).slice(0, 50);
    const result = await this.throttle.deleteOne({ _id: throttleKey(username) });
    if (result.deletedCount > 0) {
      const user = await this.users.findOne({ username });
      await this.record(
        'LOCKOUT_CLEARED',
        user ? user.username : UNKNOWN_USERNAME,
        user?._id ?? null,
        null,
        meta,
      );
    }
    return result.deletedCount > 0;
  }

  private async registerFailure(key: string, now: Date): Promise<boolean> {
    const doc = await this.throttle.findOneAndUpdate(
      { _id: key },
      {
        $inc: { failures: 1 },
        $set: { expiresAt: new Date(now.getTime() + this.config.lockoutMs) },
        $setOnInsert: { lockedUntil: null },
      },
      { upsert: true, returnDocument: 'after' },
    );
    if (doc && doc.failures >= this.config.maxFailedLogins) {
      const lockedUntil = new Date(now.getTime() + this.config.lockoutMs);
      await this.throttle.updateOne(
        { _id: key },
        { $set: { failures: 0, lockedUntil, expiresAt: lockedUntil } },
      );
      return true;
    }
    return false;
  }

  private async record(
    type: AuthEventType,
    username: string,
    userId: ObjectId | null,
    reason: string | null,
    meta: RequestMeta,
  ): Promise<void> {
    await this.events.insertOne({
      occurredAt: new Date(),
      type,
      username: username.slice(0, 50) || '(empty)',
      userId,
      reason,
      requestId: meta.requestId ?? null,
    });
  }
}

/** Logged in place of an attempted username that does not belong to an account. */
export const UNKNOWN_USERNAME = '(unknown)';

/**
 * Lockout counters are keyed by a SHA-256 of the attempted username, so the typed text (which may
 * be a mistyped password) is never stored as-is. Unknown and known names are counted the same way.
 */
export function throttleKey(username: string): string {
  return `u:${createHash('sha256').update(username).digest('hex')}`;
}

function minDate(a: Date, b: Date): Date {
  return a <= b ? a : b;
}
