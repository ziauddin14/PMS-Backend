import { Router, type Express } from 'express';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthService, hashSessionToken } from '../../src/auth/authService.js';
import { AUTH_COLLECTIONS, ensureAuthCollections } from '../../src/auth/collections.js';
import { UserAdmin } from '../../src/auth/userAdmin.js';
import type { AppConfig } from '../../src/config/env.js';
import {
  dashboardSummarySchema,
  sessionResponseSchema,
  type SessionResponse,
} from '../../src/contracts/api.js';
import { COLLECTIONS, ensureInfrastructureCollections } from '../../src/db/collections.js';
import { connectToDatabase, type Database } from '../../src/db/mongo.js';
import { createApp } from '../../src/http/app.js';
import { authenticate, requireCsrf, requireRole } from '../../src/http/authMiddleware.js';
import { RecordStore } from '../../src/records/recordStore.js';
import { capturingLogger, testConfig } from '../helpers.js';
import { startReplicaSet } from './memoryMongo.js';

// Synthetic accounts and passwords used only by these tests.
const OPERATOR = { username: 'synthetic.operator', password: 'synthetic operator pass 1' };
const VIEWER = { username: 'synthetic.viewer', password: 'synthetic viewer pass 22' };

let replSet: MongoMemoryReplSet;
let database: Database;
let uri: string;

beforeAll(async () => {
  replSet = await startReplicaSet();
  uri = replSet.getUri();
  database = await connectToDatabase(
    testConfig({ MONGODB_URI: uri, MONGODB_DB_NAME: 'pms_auth_test' }).mongodb,
    capturingLogger().logger,
  );
});

afterAll(async () => {
  await database?.close();
  await replSet?.stop();
});

interface Harness {
  app: Express;
  config: AppConfig;
  service: AuthService;
  admin: UserAdmin;
  logLines: string[];
}

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const config = testConfig({
    MONGODB_URI: uri,
    MONGODB_DB_NAME: 'pms_auth_test',
    LOGIN_MAX_FAILURES: '3',
    LOGIN_RATE_LIMIT_MAX: '200',
    ...env,
  });
  const { logger, lines } = capturingLogger();
  const service = new AuthService(database, config.auth);
  const admin = new UserAdmin(
    database.db,
    new RecordStore(database),
    { type: 'SYSTEM', label: 'test' },
    (id) => service.revokeAllSessions(id),
  );
  const testOnly = Router();
  testOnly.post(
    '/test/operator-only',
    authenticate(service, config.auth),
    requireRole('OPERATOR'),
    requireCsrf(),
    (_req, res) => res.json({ ok: true }),
  );
  const app = createApp({
    config,
    logger,
    database,
    authService: service,
    extraRouters: [testOnly],
  });
  return { app, config, service, admin, logLines: lines };
}

beforeEach(async () => {
  await database.db.dropDatabase();
  await ensureInfrastructureCollections(database.db);
  await ensureAuthCollections(database.db);
  const { admin } = await harness();
  await admin.create({ ...OPERATOR, displayName: 'Synthetic Operator', role: 'OPERATOR' });
  await admin.create({ ...VIEWER, displayName: 'Synthetic Viewer', role: 'VIEWER' });
});

function login(app: Express, username: string, password: string) {
  return request(app).post('/api/auth/login').send({ username, password });
}

function sessionCookie(res: request.Response): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((c) => c.startsWith('pms_session='));
  if (!cookie) throw new Error('no session cookie');
  return cookie.split(';')[0] as string;
}

async function signedIn(h: Harness, account = OPERATOR) {
  const res = await login(h.app, account.username, account.password);
  expect(res.status).toBe(200);
  return { cookie: sessionCookie(res), body: res.body as SessionResponse, raw: res };
}

describe('POST /api/auth/login', () => {
  it('validates input on the server', async () => {
    const { app } = await harness();
    const empty = await request(app).post('/api/auth/login').send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('VALIDATION_FAILED');
    expect(empty.body.error.details.map((d: { path: string }) => d.path)).toEqual(
      expect.arrayContaining(['username', 'password']),
    );
    const extra = await request(app)
      .post('/api/auth/login')
      .send({ username: 'a', password: 'b', role: 'OPERATOR' });
    expect(extra.status).toBe(400);
    const tooLong = await login(app, 'x'.repeat(51), 'y');
    expect(tooLong.status).toBe(400);
  });

  it('gives the same generic error for a wrong password and an unknown user', async () => {
    const { app } = await harness();
    const wrong = await login(app, OPERATOR.username, 'synthetic wrong password');
    const unknown = await login(app, 'nobody.here', 'synthetic wrong password');
    for (const res of [wrong, unknown]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid username or password',
      });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('signs in, sets an HttpOnly session cookie and returns no session token in the body', async () => {
    const h = await harness();
    const { cookie, body, raw } = await signedIn(h);
    const setCookie = (raw.headers['set-cookie'] as unknown as string[])[0] as string;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Secure/i); // test environment uses http
    expect(raw.headers['cache-control']).toBe('no-store');

    const parsed = sessionResponseSchema.parse(body);
    expect(parsed.user).toMatchObject({ username: OPERATOR.username, role: 'OPERATOR' });
    const token = cookie.split('=')[1] as string;
    expect(JSON.stringify(body)).not.toContain(token);
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|scrypt/);

    // Only the SHA-256 of the token is stored.
    const sessions = await database.db.collection(AUTH_COLLECTIONS.sessions).find().toArray();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?._id).toBe(hashSessionToken(token));
    expect(sessions[0]?._id).not.toBe(token);
  });

  it('accepts usernames case-insensitively', async () => {
    const { app } = await harness();
    const res = await login(app, '  Synthetic.Operator ', OPERATOR.password);
    expect(res.status).toBe(200);
  });

  it('locks the attempted username after repeated failures, even for the right password', async () => {
    const { app } = await harness();
    await login(app, OPERATOR.username, 'synthetic wrong 1').expect(401);
    await login(app, OPERATOR.username, 'synthetic wrong 2').expect(401);
    const third = await login(app, OPERATOR.username, 'synthetic wrong 3');
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('ACCOUNT_LOCKED');
    const correct = await login(app, OPERATOR.username, OPERATOR.password);
    expect(correct.status).toBe(429);
    // Other accounts are unaffected.
    await login(app, VIEWER.username, VIEWER.password).expect(200);
  });

  it('locks unknown usernames the same way (no account enumeration)', async () => {
    const { app } = await harness();
    for (let i = 0; i < 2; i += 1) await login(app, 'ghost.user', 'synthetic guess').expect(401);
    const res = await login(app, 'ghost.user', 'synthetic guess');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('ACCOUNT_LOCKED');
  });

  it('rate-limits sign-in requests per client', async () => {
    const { app } = await harness({ LOGIN_RATE_LIMIT_MAX: '2' });
    await login(app, 'a.user', 'synthetic 1');
    await login(app, 'b.user', 'synthetic 2');
    const res = await login(app, 'c.user', 'synthetic 3');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
  });

  it('never stores or logs passwords', async () => {
    const h = await harness();
    await login(h.app, OPERATOR.username, 'synthetic wrong password');
    await signedIn(h);
    const logs = h.logLines.join('\n');
    expect(logs).not.toContain(OPERATOR.password);
    expect(logs).not.toContain('synthetic wrong password');
    const events = JSON.stringify(
      await database.db.collection(AUTH_COLLECTIONS.authEvents).find().toArray(),
    );
    expect(events).toContain('LOGIN_FAILED');
    expect(events).toContain('LOGIN_SUCCEEDED');
    expect(events).not.toContain(OPERATOR.password);
    expect(events).not.toContain('synthetic wrong password');
    const audits = JSON.stringify(
      await database.db.collection(COLLECTIONS.auditEvents).find().toArray(),
    );
    expect(audits).toContain('[REDACTED]');
    expect(audits).not.toMatch(/scrypt\$/);
  });

  it('never stores a password typed into the username field (regression)', async () => {
    const h = await harness();
    const typedIntoUsername = 'Synthetic-Secret-Typed-As-Username-77';
    // Three attempts: failure events, then the lockout event, then a LOCKED rejection.
    for (let i = 0; i < 3; i += 1) {
      await login(h.app, typedIntoUsername, 'synthetic other field');
    }
    await login(h.app, typedIntoUsername, 'synthetic other field').expect(429);

    const leaks = (text: string) =>
      text.includes(typedIntoUsername) ||
      text.toLowerCase().includes(typedIntoUsername.toLowerCase());
    for (const name of [
      AUTH_COLLECTIONS.authEvents,
      AUTH_COLLECTIONS.loginThrottle,
      AUTH_COLLECTIONS.sessions,
      COLLECTIONS.auditEvents,
    ]) {
      const dump = JSON.stringify(await database.db.collection(name).find().toArray());
      expect(leaks(dump), `${name} must not contain the typed text`).toBe(false);
    }
    expect(leaks(h.logLines.join('\n')), 'request logs must not contain it').toBe(false);

    const events = await database.db.collection(AUTH_COLLECTIONS.authEvents).find().toArray();
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(new Set(events.map((e) => e.username))).toEqual(new Set(['(unknown)']));
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['LOGIN_FAILED', 'ACCOUNT_LOCKED']),
    );
    const throttle = await database.db.collection(AUTH_COLLECTIONS.loginThrottle).findOne();
    expect(String(throttle?._id)).toMatch(/^u:[a-f0-9]{64}$/);
  });

  it('still records real account names for failures on existing accounts', async () => {
    const { app } = await harness();
    await login(app, OPERATOR.username, 'synthetic wrong password').expect(401);
    const event = await database.db
      .collection(AUTH_COLLECTIONS.authEvents)
      .findOne({ type: 'LOGIN_FAILED' });
    expect(event).toMatchObject({ username: OPERATOR.username, reason: 'BAD_PASSWORD' });
  });
});

describe('lockout recovery', () => {
  it('lets an administrator clear a lockout without changing the rules', async () => {
    const h = await harness();
    for (let i = 0; i < 3; i += 1) await login(h.app, OPERATOR.username, 'synthetic wrong');
    await login(h.app, OPERATOR.username, OPERATOR.password).expect(429);

    expect(await h.service.clearLockout(OPERATOR.username)).toBe(true);
    await login(h.app, OPERATOR.username, OPERATOR.password).expect(200);
    expect(await h.service.clearLockout(OPERATOR.username)).toBe(false);

    const cleared = await database.db
      .collection(AUTH_COLLECTIONS.authEvents)
      .findOne({ type: 'LOCKOUT_CLEARED' });
    expect(cleared?.username).toBe(OPERATOR.username);

    // The rules are unchanged afterwards: new failures lock again.
    for (let i = 0; i < 3; i += 1) await login(h.app, OPERATOR.username, 'synthetic wrong');
    await login(h.app, OPERATOR.username, OPERATOR.password).expect(429);
  });
});

describe('sessions', () => {
  it('returns the current session with a valid cookie and 401 otherwise', async () => {
    const h = await harness();
    const { cookie, body } = await signedIn(h);
    const ok = await request(h.app).get('/api/auth/session').set('Cookie', cookie);
    expect(ok.status).toBe(200);
    expect(ok.body.user.username).toBe(OPERATOR.username);
    expect(ok.body.csrfToken).toBe(body.csrfToken);

    const none = await request(h.app).get('/api/auth/session');
    expect(none.status).toBe(401);
    expect(none.body.error.code).toBe('UNAUTHENTICATED');

    const forged = await request(h.app)
      .get('/api/auth/session')
      .set('Cookie', 'pms_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(forged.status).toBe(401);
    const garbage = await request(h.app).get('/api/auth/session').set('Cookie', 'pms_session=<x>');
    expect(garbage.status).toBe(401);
  });

  it('expires sessions after their absolute lifetime', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h);
    await database.db
      .collection(AUTH_COLLECTIONS.sessions)
      .updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await request(h.app).get('/api/auth/session').set('Cookie', cookie);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
    expect(String(res.headers['set-cookie'])).toMatch(/pms_session=;/);
    expect(await database.db.collection(AUTH_COLLECTIONS.sessions).countDocuments()).toBe(0);
  });

  it('expires idle sessions', async () => {
    const h = await harness();
    const { cookie } = await signedIn(h);
    await database.db
      .collection(AUTH_COLLECTIONS.sessions)
      .updateMany({}, { $set: { idleExpiresAt: new Date(Date.now() - 1000) } });
    const res = await request(h.app).get('/api/auth/session').set('Cookie', cookie);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('logs out only with the CSRF token and then invalidates the session', async () => {
    const h = await harness();
    const { cookie, body } = await signedIn(h);

    const noToken = await request(h.app).post('/api/auth/logout').set('Cookie', cookie);
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_FAILED');
    const badToken = await request(h.app)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', 'x'.repeat(43));
    expect(badToken.status).toBe(403);

    const out = await request(h.app)
      .post('/api/auth/logout')
      .set('Cookie', cookie)
      .set('X-CSRF-Token', body.csrfToken);
    expect(out.status).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/pms_session=;/);

    const after = await request(h.app).get('/api/auth/session').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });

  it('rejects logout without a session', async () => {
    const { app } = await harness();
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(401);
  });

  it('ends sessions when an account is disabled or its password changes', async () => {
    const h = await harness();
    const operator = await signedIn(h);
    const viewer = await signedIn(h, VIEWER);

    await h.admin.setPassword(OPERATOR.username, 'synthetic new operator pass');
    await request(h.app).get('/api/auth/session').set('Cookie', operator.cookie).expect(401);
    await login(h.app, OPERATOR.username, OPERATOR.password).expect(401);
    await login(h.app, OPERATOR.username, 'synthetic new operator pass').expect(200);

    await h.admin.disable(VIEWER.username, 'synthetic test');
    await request(h.app).get('/api/auth/session').set('Cookie', viewer.cookie).expect(401);
    const disabled = await login(h.app, VIEWER.username, VIEWER.password);
    expect(disabled.status).toBe(401);
    expect(disabled.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});

describe('route protection and roles', () => {
  it('protects the dashboard on the server', async () => {
    const h = await harness();
    const anonymous = await request(h.app).get('/api/dashboard/summary');
    expect(anonymous.status).toBe(401);

    const { cookie } = await signedIn(h, VIEWER);
    const res = await request(h.app).get('/api/dashboard/summary').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const summary = dashboardSummarySchema.parse(res.body);
    expect(summary.user.role).toBe('VIEWER');
    expect(summary.system.database).toBe('up');
    expect(summary.indicators.length).toBeGreaterThan(0);
    // No invented figures: every indicator is unavailable until its module exists.
    for (const indicator of summary.indicators) {
      expect(indicator.status).toBe('not_available');
      expect(indicator.value).toBeNull();
      expect(indicator.plannedMilestone).toMatch(/^M\d+/);
    }
  });

  it('enforces roles: read-only viewers cannot use operator actions', async () => {
    const h = await harness();
    const viewer = await signedIn(h, VIEWER);
    const forbidden = await request(h.app)
      .post('/api/test/operator-only')
      .set('Cookie', viewer.cookie)
      .set('X-CSRF-Token', viewer.body.csrfToken);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');

    const operator = await signedIn(h);
    const allowed = await request(h.app)
      .post('/api/test/operator-only')
      .set('Cookie', operator.cookie)
      .set('X-CSRF-Token', operator.body.csrfToken);
    expect(allowed.status).toBe(200);

    const anonymous = await request(h.app).post('/api/test/operator-only');
    expect(anonymous.status).toBe(401);
  });

  it('allows the CSRF header in CORS preflight for allowed origins only', async () => {
    const { app } = await harness();
    const ok = await request(app)
      .options('/api/auth/logout')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, X-CSRF-Token');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-headers']).toMatch(/X-CSRF-Token/i);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(app)
      .post('/api/auth/login')
      .set('Origin', 'https://evil.example.com')
      .send({ username: OPERATOR.username, password: OPERATOR.password });
    expect(evil.status).toBe(403);
  });
});

describe('user administration', () => {
  it('rejects weak passwords and duplicate usernames', async () => {
    const { admin } = await harness();
    await expect(
      admin.create({
        username: 'weak.user',
        displayName: 'Weak',
        role: 'VIEWER',
        password: 'short',
      }),
    ).rejects.toThrow(/validation/i);
    await expect(
      admin.create({ ...OPERATOR, displayName: 'Duplicate', role: 'OPERATOR' }),
    ).rejects.toThrow(/already exists/);
  });

  it('stores users as audited records with redacted password hashes', async () => {
    const { admin } = await harness();
    const users = await admin.list();
    expect(users.map((u) => u.username)).toEqual([OPERATOR.username, VIEWER.username]);
    expect(users[0]?.code).toMatch(/^USR-\d{6}$/);
    expect(JSON.stringify(users)).not.toMatch(/passwordHash|scrypt/);
    const event = await database.db
      .collection(COLLECTIONS.auditEvents)
      .findOne({ 'entity.collection': 'users', action: 'CREATE' });
    const hashChange = (event?.changes as Array<{ field: string; after: unknown }>).find(
      (c) => c.field === 'passwordHash',
    );
    expect(hashChange?.after).toBe('[REDACTED]');
  });
});
