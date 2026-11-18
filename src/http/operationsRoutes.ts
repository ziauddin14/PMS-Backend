import { Router, type Response } from 'express';
import type { AppConfig } from '../config/env.js';
import type { AuthService } from '../auth/authService.js';
import {
  cancelWithReasonSchema,
  dispatchCreateSchema,
  dispatchListQuerySchema,
  dispatchUpdateSchema,
  openingStockCreateSchema,
  openingStockListQuerySchema,
  paymentCreateSchema,
  paymentListQuerySchema,
  receiptCreateSchema,
  receiptListQuerySchema,
  reportKeys,
  reportQuerySchema,
  stockBalanceQuerySchema,
  stockMovementQuerySchema,
  syncJobQuerySchema,
  uploadSignatureRequestSchema,
  type CancelWithReasonInput,
  type DispatchCreateInput,
  type DispatchUpdateInput,
  type OpeningStockCreateInput,
  type PaymentCreateInput,
  type ReceiptCreateInput,
  type ReportKey,
  type UploadSignatureRequest,
} from '../contracts/operations.js';
import type { DispatchService } from '../dispatch/dispatchService.js';
import type { MutationContext } from '../domain/context.js';
import { NotFoundError } from '../errors.js';
import type { OpeningStockService } from '../inventory/openingStockService.js';
import type { ReceiptService } from '../inventory/receiptService.js';
import type { StockService } from '../inventory/stockService.js';
import type { PaymentService } from '../payments/paymentService.js';
import { toCsv, type ReportService } from '../reports/reportService.js';
import type { SyncStatusService } from '../sync/syncStatusService.js';
import { signUpload } from '../uploads/cloudinary.js';
import { parseOrThrow } from '../validation.js';
import { authenticate, getAuth, requireCsrf, requireRole } from './authMiddleware.js';
import { validateBody } from './middleware.js';

export interface OperationsServices {
  receipts: ReceiptService;
  stock: StockService;
  openingStock: OpeningStockService;
  dispatches: DispatchService;
  payments: PaymentService;
  sync: SyncStatusService;
  reports: ReportService;
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
 * M7–M11 API: receiving, stock, dispatch/Bilty, vendor payments, sync status and reports.
 * Every signed-in user (OPERATOR, VIEWER) may read; only the Production Operator may write, and
 * every write needs the CSRF header. Roles are enforced here, never only in the browser.
 */
export function operationsRoutes(
  authService: AuthService,
  config: AppConfig,
  services: OperationsServices,
): Router {
  const router = Router();
  const readers = [authenticate(authService, config.auth), requireRole('OPERATOR', 'VIEWER')];
  const writers = [authenticate(authService, config.auth), requireRole('OPERATOR'), requireCsrf()];
  const id = (value: unknown) => String(value);

  // ---- M7 receiving ----
  router.get('/receipts', ...readers, async (req, res) => {
    res.json(await services.receipts.list(parseOrThrow(receiptListQuerySchema, req.query)));
  });
  router.get('/receipts/:id', ...readers, async (req, res) => {
    res.json(await services.receipts.get(id(req.params.id)));
  });
  router.post('/receipts', ...writers, validateBody(receiptCreateSchema), async (_req, res) => {
    res
      .status(201)
      .json(
        await services.receipts.create(res.locals.body as ReceiptCreateInput, mutationContext(res)),
      );
  });
  router.post(
    '/receipts/:id/cancel',
    ...writers,
    validateBody(cancelWithReasonSchema),
    async (req, res) => {
      res.json(
        await services.receipts.cancel(
          id(req.params.id),
          res.locals.body as CancelWithReasonInput,
          mutationContext(res),
        ),
      );
    },
  );

  // ---- Image uploads: the browser sends files straight to Cloudinary with a signature ----
  router.get('/uploads/config', ...readers, (_req, res) => {
    res.json({ enabled: config.uploads !== null });
  });
  router.post(
    '/uploads/signature',
    ...writers,
    validateBody(uploadSignatureRequestSchema),
    (_req, res) => {
      const { purpose } = res.locals.body as UploadSignatureRequest;
      res.json(signUpload(config.uploads, purpose));
    },
  );

  // ---- M7 stock ----
  router.get('/stock/balances', ...readers, async (req, res) => {
    res.json(await services.stock.balances(parseOrThrow(stockBalanceQuerySchema, req.query)));
  });
  router.get('/stock/movements', ...readers, async (req, res) => {
    res.json(await services.stock.movements(parseOrThrow(stockMovementQuerySchema, req.query)));
  });

  // ---- Opening stock (goods already in a warehouse) ----
  router.get('/stock/opening', ...readers, async (req, res) => {
    res.json(
      await services.openingStock.list(parseOrThrow(openingStockListQuerySchema, req.query)),
    );
  });
  router.get('/stock/opening/:id', ...readers, async (req, res) => {
    res.json(await services.openingStock.get(id(req.params.id)));
  });
  router.post(
    '/stock/opening',
    ...writers,
    validateBody(openingStockCreateSchema),
    async (_req, res) => {
      res
        .status(201)
        .json(
          await services.openingStock.create(
            res.locals.body as OpeningStockCreateInput,
            mutationContext(res),
          ),
        );
    },
  );
  router.post(
    '/stock/opening/:id/cancel',
    ...writers,
    validateBody(cancelWithReasonSchema),
    async (req, res) => {
      res.json(
        await services.openingStock.cancel(
          id(req.params.id),
          res.locals.body as CancelWithReasonInput,
          mutationContext(res),
        ),
      );
    },
  );

  // ---- M8 dispatch ----
  router.get('/dispatches', ...readers, async (req, res) => {
    res.json(await services.dispatches.list(parseOrThrow(dispatchListQuerySchema, req.query)));
  });
  router.get('/dispatches/:id', ...readers, async (req, res) => {
    res.json(await services.dispatches.get(id(req.params.id)));
  });
  router.post('/dispatches', ...writers, validateBody(dispatchCreateSchema), async (_req, res) => {
    res
      .status(201)
      .json(
        await services.dispatches.create(
          res.locals.body as DispatchCreateInput,
          mutationContext(res),
        ),
      );
  });
  router.patch(
    '/dispatches/:id',
    ...writers,
    validateBody(dispatchUpdateSchema),
    async (req, res) => {
      res.json(
        await services.dispatches.update(
          id(req.params.id),
          res.locals.body as DispatchUpdateInput,
          mutationContext(res),
        ),
      );
    },
  );
  router.post(
    '/dispatches/:id/cancel',
    ...writers,
    validateBody(cancelWithReasonSchema),
    async (req, res) => {
      res.json(
        await services.dispatches.cancel(
          id(req.params.id),
          res.locals.body as CancelWithReasonInput,
          mutationContext(res),
        ),
      );
    },
  );

  // ---- M9 payments ----
  router.get('/payments', ...readers, async (req, res) => {
    res.json(await services.payments.list(parseOrThrow(paymentListQuerySchema, req.query)));
  });
  router.get('/payments/:id', ...readers, async (req, res) => {
    res.json(await services.payments.get(id(req.params.id)));
  });
  router.post('/payments', ...writers, validateBody(paymentCreateSchema), async (_req, res) => {
    res
      .status(201)
      .json(
        await services.payments.create(res.locals.body as PaymentCreateInput, mutationContext(res)),
      );
  });
  router.post(
    '/payments/:id/cancel',
    ...writers,
    validateBody(cancelWithReasonSchema),
    async (req, res) => {
      res.json(
        await services.payments.cancel(
          id(req.params.id),
          res.locals.body as CancelWithReasonInput,
          mutationContext(res),
        ),
      );
    },
  );

  // ---- M10 sync status ----
  router.get('/sync/summary', ...readers, async (_req, res) => {
    res.json(await services.sync.summary());
  });
  router.get('/sync/jobs', ...readers, async (req, res) => {
    res.json(await services.sync.list(parseOrThrow(syncJobQuerySchema, req.query)));
  });
  router.post('/sync/jobs/:id/retry', ...writers, async (req, res) => {
    res.json(await services.sync.retry(id(req.params.id)));
  });

  // ---- M11 reports ----
  router.get('/reports/:key', ...readers, async (req, res) => {
    const key = id(req.params.key);
    if (!(reportKeys as readonly string[]).includes(key)) throw new NotFoundError('Unknown report');
    const query = parseOrThrow(reportQuerySchema, req.query);
    const report = await services.reports.run(key as ReportKey, query);
    if (query.format === 'csv') {
      const day = report.generatedAt.slice(0, 10);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${key}-${day}.csv"`);
      res.setHeader('Cache-Control', 'no-store');
      res.send(toCsv(report));
      return;
    }
    res.json(report);
  });

  return router;
}
