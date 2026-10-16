import cors from 'cors';
import type { RequestHandler } from 'express';
import { sendError } from './middleware.js';

/**
 * CORS with an explicit allow-list. Requests that carry an `Origin` header not on the list are
 * rejected with 403 (including preflight). Requests without an `Origin` header (server-to-server,
 * health checks) are not affected by CORS.
 */
export function corsWithAllowList(allowedOrigins: readonly string[]): RequestHandler[] {
  const allowed = new Set(allowedOrigins);

  const rejectUnknownOrigin: RequestHandler = (req, res, next) => {
    const origin = req.get('origin');
    if (origin && !allowed.has(origin)) {
      sendError(res, 403, { code: 'FORBIDDEN_ORIGIN', message: 'Origin not allowed' });
      return;
    }
    next();
  };

  const corsMiddleware = cors({
    origin: (origin, callback) => callback(null, origin ? allowed.has(origin) : false),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Request-Id', 'X-CSRF-Token'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
  });

  return [rejectUnknownOrigin, corsMiddleware];
}
