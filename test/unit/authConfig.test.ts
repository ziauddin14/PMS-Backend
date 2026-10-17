import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { readCookie, sessionCookieName } from '../../src/http/authMiddleware.js';

const base = {
  NODE_ENV: 'development',
  MONGODB_URI: 'mongodb://127.0.0.1:27017',
  MONGODB_DB_NAME: 'pms_dev',
};

describe('session configuration', () => {
  it('uses safe defaults', () => {
    const { auth } = loadConfig(base);
    expect(auth.sessionTtlMs).toBe(12 * 3_600_000);
    expect(auth.sessionIdleMs).toBe(120 * 60_000);
    expect(auth.cookieSecure).toBe(false);
    expect(auth.cookieSameSite).toBe('lax');
    expect(auth.maxFailedLogins).toBe(5);
    expect(auth.lockoutMs).toBe(15 * 60_000);
  });

  it('defaults to secure cookies in production and refuses insecure ones', () => {
    const prod = {
      ...base,
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://pms.example.org',
    };
    expect(loadConfig(prod).auth.cookieSecure).toBe(true);
    expect(() => loadConfig({ ...prod, SESSION_COOKIE_SECURE: 'false' })).toThrow(
      /SESSION_COOKIE_SECURE/,
    );
  });

  it('requires secure cookies for SameSite=None', () => {
    expect(() => loadConfig({ ...base, SESSION_COOKIE_SAMESITE: 'none' })).toThrow(ConfigError);
    expect(
      loadConfig({ ...base, SESSION_COOKIE_SAMESITE: 'none', SESSION_COOKIE_SECURE: 'true' }).auth
        .cookieSameSite,
    ).toBe('none');
  });

  it('rejects an idle timeout longer than the session lifetime', () => {
    expect(() =>
      loadConfig({ ...base, SESSION_TTL_HOURS: '1', SESSION_IDLE_MINUTES: '120' }),
    ).toThrow(/SESSION_IDLE_MINUTES/);
  });
});

describe('session cookie helpers', () => {
  it('uses the __Host- prefix only for secure cookies', () => {
    expect(sessionCookieName({ cookieSecure: true } as never)).toBe('__Host-pms_session');
    expect(sessionCookieName({ cookieSecure: false } as never)).toBe('pms_session');
  });

  it('reads a named cookie and ignores malformed ones', () => {
    const req = (cookie?: string) => ({ headers: { cookie } }) as unknown as Request;
    expect(readCookie(req('a=1; pms_session=abc; b=2'), 'pms_session')).toBe('abc');
    expect(readCookie(req('pms_session_other=x'), 'pms_session')).toBeUndefined();
    expect(readCookie(req(undefined), 'pms_session')).toBeUndefined();
    expect(readCookie(req('pms_session=%E0%A4%A'), 'pms_session')).toBeUndefined();
  });
});
