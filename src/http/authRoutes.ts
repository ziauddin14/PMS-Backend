import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from '../config/env.js';
import { loginRequestSchema, type LoginRequest, type SessionResponse } from '../contracts/api.js';
import type { AuthenticatedContext, AuthService } from '../auth/authService.js';
import { toSessionUser } from '../auth/users.js';
import {
  authenticate,
  clearSessionCookie,
  getAuth,
  requireCsrf,
  setSessionCookie,
} from './authMiddleware.js';
import { sendError, validateBody } from './middleware.js';

function sessionBody(context: AuthenticatedContext): SessionResponse {
  return {
    user: toSessionUser(context.user),
    csrfToken: context.session.csrfToken,
    expiresAt: context.session.expiresAt.toISOString(),
    idleExpiresAt: context.session.idleExpiresAt.toISOString(),
  };
}

function meta(res: Response, userAgent: string | undefined) {
  return { requestId: res.locals.requestId as string | undefined, userAgent };
}

export function authRoutes(service: AuthService, config: AppConfig): Router {
  const router = Router();
  const auth = config.auth;

  const loginLimiter = rateLimit({
    windowMs: auth.loginRateLimitWindowMs,
    limit: auth.loginRateLimitMax,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, res) =>
      sendError(res, 429, {
        code: 'RATE_LIMITED',
        message: 'Too many sign-in attempts. Try again later.',
      }),
  });

  router.post('/auth/login', loginLimiter, validateBody(loginRequestSchema), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const body = res.locals.body as LoginRequest;
    const { token, session, user } = await service.login(
      body.username,
      body.password,
      meta(res, req.get('user-agent')),
    );
    setSessionCookie(res, auth, token, session.expiresAt);
    res.json(sessionBody({ user, session }));
  });

  router.get('/auth/session', authenticate(service, auth), (_req, res) => {
    res.json(sessionBody(getAuth(res)));
  });

  router.post('/auth/logout', authenticate(service, auth), requireCsrf(), async (req, res) => {
    await service.logout(getAuth(res), meta(res, req.get('user-agent')));
    clearSessionCookie(res, auth);
    res.status(204).end();
  });

  return router;
}
