import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { AppConfig } from '../config/env.js';
import type { UserRole } from '../contracts/api.js';
import type { AuthenticatedContext, AuthService } from '../auth/authService.js';
import { ForbiddenError, UnauthenticatedError } from '../errors.js';

/** `__Host-` cookies must be Secure, Path=/ and have no Domain: the browser enforces this. */
export function sessionCookieName(config: AppConfig['auth']): string {
  return config.cookieSecure ? '__Host-pms_session' : 'pms_session';
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function setSessionCookie(
  res: Response,
  config: AppConfig['auth'],
  token: string,
  expiresAt: Date,
): void {
  res.cookie(sessionCookieName(config), token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: Response, config: AppConfig['auth']): void {
  res.clearCookie(sessionCookieName(config), {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    path: '/',
  });
}

export function getAuth(res: Response): AuthenticatedContext {
  const auth = res.locals.auth as AuthenticatedContext | undefined;
  if (!auth) throw new UnauthenticatedError();
  return auth;
}

/**
 * Requires a valid session. Sets `res.locals.auth` and disables caching of the response.
 * This is the server-side gate; the frontend's route protection is only for user experience.
 */
export function authenticate(service: AuthService, config: AppConfig['auth']): RequestHandler {
  return async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const token = readCookie(req, sessionCookieName(config));
    if (!token) throw new UnauthenticatedError();
    const result = await service.resolve(token, {
      requestId: res.locals.requestId as string | undefined,
    });
    if (result === 'expired') {
      clearSessionCookie(res, config);
      throw new UnauthenticatedError(
        'Your session has expired. Please sign in again.',
        'SESSION_EXPIRED',
      );
    }
    if (!result) {
      clearSessionCookie(res, config);
      throw new UnauthenticatedError();
    }
    res.locals.auth = result;
    next();
  };
}

/** Allows only the listed roles. Must run after `authenticate`. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  return (_req, res, next) => {
    if (!roles.includes(getAuth(res).user.role)) throw new ForbiddenError();
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection for cookie-authenticated requests: state-changing requests must echo the
 * session's CSRF token in `X-CSRF-Token`. A custom header also forces a CORS preflight, so only
 * allow-listed origins can send it. Must run after `authenticate`.
 */
export function requireCsrf(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const expected = Buffer.from(getAuth(res).session.csrfToken);
    const provided = Buffer.from(req.get('x-csrf-token') ?? '');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new ForbiddenError(
        'Security check failed. Reload the page and try again.',
        'CSRF_FAILED',
      );
    }
    next();
  };
}
