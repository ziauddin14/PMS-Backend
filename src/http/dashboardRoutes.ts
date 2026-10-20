import { Router } from 'express';
import type { AppConfig } from '../config/env.js';
import type { DashboardIndicator, DashboardSummary } from '../contracts/api.js';
import type { AuthService } from '../auth/authService.js';
import { toSessionUser } from '../auth/users.js';
import { authenticate, getAuth, requireRole } from './authMiddleware.js';
import type { DatabaseProbe } from './healthRoutes.js';

/**
 * Dashboard indicators. Each one stays `not_available` (value null) until the module that owns
 * its data is built; the dashboard never shows invented figures.
 */
export const DASHBOARD_INDICATORS: ReadonlyArray<Omit<DashboardIndicator, 'status' | 'value'>> = [
  {
    key: 'openDemands',
    label: 'Open demands',
    description: 'Demand lines not yet fully dispatched',
    plannedMilestone: 'M5 Demand Management',
  },
  {
    key: 'activePurchaseOrders',
    label: 'Active purchase orders',
    description: 'Purchase orders not yet quantity-complete',
    plannedMilestone: 'M6 PO & Vendor Management',
  },
  {
    key: 'stockLots',
    label: 'Stock on hand',
    description: 'Units held in warehouses, by PO/item lot',
    plannedMilestone: 'M7 Receiving & Stock Management',
  },
  {
    key: 'dispatchesThisMonth',
    label: 'Dispatches this month',
    description: 'Bilty dispatches recorded this calendar month',
    plannedMilestone: 'M8 Dispatch/Bilty/Documents',
  },
  {
    key: 'outstandingVendorPayments',
    label: 'Outstanding vendor payments',
    description: 'Approved PO amounts not yet paid',
    plannedMilestone: 'M9 Vendor Payments & Finance Records',
  },
  {
    key: 'pendingRecovery',
    label: 'Pending division recovery',
    description: 'Amounts still to be recovered from divisions/provinces',
    plannedMilestone: 'M9 Vendor Payments & Finance Records',
  },
];

/**
 * Sources for indicators whose module exists. An indicator without a source (or whose source
 * fails) stays `not_available`; nothing is estimated.
 */
export type IndicatorSources = Partial<Record<string, () => Promise<number>>>;

export function dashboardRoutes(
  service: AuthService,
  config: AppConfig,
  database: DatabaseProbe,
  sources: IndicatorSources = {},
): Router {
  const router = Router();

  router.get(
    '/dashboard/summary',
    authenticate(service, config.auth),
    requireRole('OPERATOR', 'VIEWER'),
    async (_req, res) => {
      const up = await database.ping().catch(() => false);
      const indicators = await Promise.all(
        DASHBOARD_INDICATORS.map(async (indicator) => {
          const source = sources[indicator.key];
          const value = source ? await source().catch(() => null) : null;
          return value === null
            ? { ...indicator, status: 'not_available' as const, value: null }
            : { ...indicator, status: 'available' as const, value, plannedMilestone: null };
        }),
      );
      const body: DashboardSummary = {
        generatedAt: new Date().toISOString(),
        user: toSessionUser(getAuth(res).user),
        indicators,
        system: { database: up ? 'up' : 'down' },
      };
      res.json(body);
    },
  );

  return router;
}
