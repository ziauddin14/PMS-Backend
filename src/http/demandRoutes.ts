import { Router, type Response } from 'express';
import type { AppConfig } from '../config/env.js';
import {
  demandCancelSchema,
  demandCreateSchema,
  demandListQuerySchema,
  demandUpdateSchema,
  type DemandCancelInput,
  type DemandCreateInput,
  type DemandUpdateInput,
} from '../contracts/api.js';
import type { AuthService } from '../auth/authService.js';
import type { DemandService } from '../demands/demandService.js';
import type { MutationContext } from '../domain/context.js';
import { parseOrThrow } from '../validation.js';
import { authenticate, getAuth, requireCsrf, requireRole } from './authMiddleware.js';
import { validateBody } from './middleware.js';

function mutationContext(res: Response): MutationContext {
  const { user } = getAuth(res);
  return {
    actor: { type: 'USER', id: user._id.toHexString(), label: user.username },
    requestId: res.locals.requestId as string | undefined,
    provenance: { sourceType: 'PMS_UI' },
  };
}

/**
 * Demand API. Signed-in users may read; only the Production Operator may create, change or
 * cancel demands (BRD §4, Rules 9–10). Receiver names/phones are returned to the operator only.
 */
export function demandRoutes(
  authService: AuthService,
  config: AppConfig,
  service: DemandService,
): Router {
  const router = Router();
  const readers = [authenticate(authService, config.auth), requireRole('OPERATOR', 'VIEWER')];
  const writers = [authenticate(authService, config.auth), requireRole('OPERATOR'), requireCsrf()];

  router.get('/demands', ...readers, async (req, res) => {
    res.json(await service.list(parseOrThrow(demandListQuerySchema, req.query)));
  });

  router.get('/demands/:id', ...readers, async (req, res) => {
    const includePersonalData = getAuth(res).user.role === 'OPERATOR';
    res.json(await service.get(String(req.params.id), { includePersonalData }));
  });

  router.post('/demands', ...writers, validateBody(demandCreateSchema), async (_req, res) => {
    const demand = await service.create(res.locals.body as DemandCreateInput, mutationContext(res));
    res.status(201).json(demand);
  });

  router.patch('/demands/:id', ...writers, validateBody(demandUpdateSchema), async (req, res) => {
    res.json(
      await service.update(
        String(req.params.id),
        res.locals.body as DemandUpdateInput,
        mutationContext(res),
      ),
    );
  });

  router.post(
    '/demands/:id/cancel',
    ...writers,
    validateBody(demandCancelSchema),
    async (req, res) => {
      res.json(
        await service.cancel(
          String(req.params.id),
          res.locals.body as DemandCancelInput,
          mutationContext(res),
        ),
      );
    },
  );

  return router;
}
