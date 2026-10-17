import { Router, type Response } from 'express';
import type { AppConfig } from '../config/env.js';
import {
  masterCreateSchema,
  masterEntityKeys,
  masterListQuerySchema,
  masterUpdateSchema,
  type MasterCreateInput,
  type MasterEntityKey,
  type MasterUpdateInput,
} from '../contracts/api.js';
import type { AuthService } from '../auth/authService.js';
import type { MutationContext } from '../domain/context.js';
import { NotFoundError } from '../errors.js';
import type { MasterDataService } from '../masterData/masterDataService.js';
import { parseOrThrow } from '../validation.js';
import { authenticate, getAuth, requireCsrf, requireRole } from './authMiddleware.js';
import { validateBody } from './middleware.js';

function entityParam(value: unknown): MasterEntityKey {
  if (typeof value === 'string' && (masterEntityKeys as readonly string[]).includes(value)) {
    return value as MasterEntityKey;
  }
  throw new NotFoundError('Unknown master-data list');
}

function mutationContext(res: Response): MutationContext {
  const { user } = getAuth(res);
  return {
    actor: { type: 'USER', id: user._id.toHexString(), label: user.username },
    requestId: res.locals.requestId as string | undefined,
    provenance: { sourceType: 'PMS_UI' },
  };
}

/**
 * Master-data API. Everyone signed in (Production Operator and read-only HOD/managers) may read;
 * only the Production Operator may create or change records (BRD §4, Rules 9–10).
 */
export function masterDataRoutes(
  authService: AuthService,
  config: AppConfig,
  service: MasterDataService,
): Router {
  const router = Router();
  const readers = [authenticate(authService, config.auth), requireRole('OPERATOR', 'VIEWER')];
  const writers = [authenticate(authService, config.auth), requireRole('OPERATOR'), requireCsrf()];

  router.get('/master/:entity', ...readers, async (req, res) => {
    const entity = entityParam(req.params.entity);
    const query = parseOrThrow(masterListQuerySchema, req.query);
    res.json(await service.list(entity, query));
  });

  router.get('/master/:entity/:id', ...readers, async (req, res) => {
    res.json(await service.get(entityParam(req.params.entity), String(req.params.id)));
  });

  router.post('/master/:entity', ...writers, validateBody(masterCreateSchema), async (req, res) => {
    const record = await service.create(
      entityParam(req.params.entity),
      res.locals.body as MasterCreateInput,
      mutationContext(res),
    );
    res.status(201).json(record);
  });

  router.patch(
    '/master/:entity/:id',
    ...writers,
    validateBody(masterUpdateSchema),
    async (req, res) => {
      const record = await service.update(
        entityParam(req.params.entity),
        String(req.params.id),
        res.locals.body as MasterUpdateInput,
        mutationContext(res),
      );
      res.json(record);
    },
  );

  return router;
}
