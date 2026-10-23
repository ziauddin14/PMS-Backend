import { Router, type Response } from 'express';
import type { AppConfig } from '../config/env.js';
import {
  purchaseOrderCancelSchema,
  purchaseOrderCreateSchema,
  purchaseOrderListQuerySchema,
  purchaseOrderUpdateSchema,
  type PurchaseOrderCancelInput,
  type PurchaseOrderCreateInput,
  type PurchaseOrderUpdateInput,
} from '../contracts/api.js';
import type { AuthService } from '../auth/authService.js';
import type { PurchaseOrderService } from '../purchaseOrders/purchaseOrderService.js';
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
 * Purchase Order API (M6).
 * Signed-in users may read; only the Production Operator may create, change or cancel POs.
 */
export function purchaseOrderRoutes(
  authService: AuthService,
  config: AppConfig,
  service: PurchaseOrderService,
): Router {
  const router = Router();
  const readers = [authenticate(authService, config.auth), requireRole('OPERATOR', 'VIEWER')];
  const writers = [authenticate(authService, config.auth), requireRole('OPERATOR'), requireCsrf()];

  router.get('/purchase-orders', ...readers, async (req, res) => {
    res.json(await service.list(parseOrThrow(purchaseOrderListQuerySchema, req.query)));
  });

  router.get('/purchase-orders/:id', ...readers, async (req, res) => {
    res.json(await service.get(String(req.params.id)));
  });

  router.post(
    '/purchase-orders',
    ...writers,
    validateBody(purchaseOrderCreateSchema),
    async (_req, res) => {
      const po = await service.create(
        res.locals.body as PurchaseOrderCreateInput,
        mutationContext(res),
      );
      res.status(201).json(po);
    },
  );

  router.patch(
    '/purchase-orders/:id',
    ...writers,
    validateBody(purchaseOrderUpdateSchema),
    async (req, res) => {
      res.json(
        await service.update(
          String(req.params.id),
          res.locals.body as PurchaseOrderUpdateInput,
          mutationContext(res),
        ),
      );
    },
  );

  router.post(
    '/purchase-orders/:id/cancel',
    ...writers,
    validateBody(purchaseOrderCancelSchema),
    async (req, res) => {
      res.json(
        await service.cancel(
          String(req.params.id),
          res.locals.body as PurchaseOrderCancelInput,
          mutationContext(res),
        ),
      );
    },
  );

  return router;
}
