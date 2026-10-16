import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from '../config/env.js';
import type { Logger } from '../logger.js';
import type { AuthService } from '../auth/authService.js';
import { authRoutes } from './authRoutes.js';
import { corsWithAllowList } from './cors.js';
import { dashboardRoutes } from './dashboardRoutes.js';
import { healthRoutes, type DatabaseProbe } from './healthRoutes.js';
import {
  errorHandler,
  notFoundHandler,
  requestId,
  requestLogger,
  sendError,
} from './middleware.js';

export interface AppDependencies {
  config: AppConfig;
  logger: Logger;
  database?: DatabaseProbe;
  /** Authentication service; when absent, the auth and dashboard routes are not mounted. */
  authService?: AuthService;
  /** Extra routers mounted under `/api` (used by tests; business routes arrive in later milestones). */
  extraRouters?: Router[];
}

export function createApp({
  config,
  logger,
  database,
  authService,
  extraRouters = [],
}: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.http.trustProxy);

  app.use(requestId());
  app.use(requestLogger(logger));
  app.use(helmet());
  app.use(...corsWithAllowList(config.http.corsAllowedOrigins));
  app.use(
    rateLimit({
      windowMs: config.http.rateLimitWindowMs,
      limit: config.http.rateLimitMax,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (_req, res) =>
        sendError(res, 429, { code: 'RATE_LIMITED', message: 'Too many requests' }),
    }),
  );
  app.use(express.json({ limit: config.http.bodyLimit }));

  app.use('/api', healthRoutes(database));
  if (authService && database) {
    app.use('/api', authRoutes(authService, config));
    app.use('/api', dashboardRoutes(authService, config, database));
  }
  for (const router of extraRouters) app.use('/api', router);

  app.use(notFoundHandler());
  app.use(errorHandler(logger));
  return app;
}
