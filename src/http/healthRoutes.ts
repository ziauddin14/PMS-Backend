import { Router } from 'express';
import type { HealthResponse, ReadinessResponse } from '../contracts/api.js';

/** Anything that can report whether the database is reachable. */
export interface DatabaseProbe {
  ping(): Promise<boolean>;
}

const READINESS_TIMEOUT_MS = 2000;

async function pingWithTimeout(probe: DatabaseProbe): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      probe.ping().catch(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), READINESS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function healthRoutes(probe: DatabaseProbe | undefined): Router {
  const router = Router();

  // Liveness: the process is up. Deliberately reveals no configuration.
  router.get('/health', (_req, res) => {
    const body: HealthResponse = {
      status: 'ok',
      service: 'mab-pms-api',
      time: new Date().toISOString(),
    };
    res.json(body);
  });

  // Readiness: the database answers a ping.
  router.get('/health/ready', async (_req, res) => {
    const up = probe ? await pingWithTimeout(probe) : false;
    const body: ReadinessResponse = {
      status: up ? 'ready' : 'not_ready',
      checks: { database: up ? 'up' : 'down' },
    };
    res.status(up ? 200 : 503).json(body);
  });

  return router;
}
