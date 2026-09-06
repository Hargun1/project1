import { Router } from 'express';
import type { HealthResponse, ReadyResponse } from '@collab/shared';
import { SERVICE_NAME, SERVICE_VERSION } from '../config/constants';
import { checkDatabaseConnection } from '../database/prisma';

export const healthRouter = Router();

/**
 * Liveness. Touches nothing external on purpose: a dependency blip must not make
 * the load balancer kill an otherwise healthy process.
 */
healthRouter.get('/healthz', (_req, res) => {
  const body: HealthResponse = {
    status: 'ok',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
  res.json(body);
});

/**
 * Readiness. Verifies the dependencies this instance needs to serve traffic, so
 * Nginx can route around a degraded instance (§6, §35).
 *
 * Redis reports `not_configured` until Phase 8 connects it — an honest signal
 * rather than a check that pretends to pass.
 */
healthRouter.get('/readyz', async (_req, res) => {
  const databaseUp = await checkDatabaseConnection();

  const body: ReadyResponse = {
    status: databaseUp ? 'ready' : 'degraded',
    checks: {
      database: databaseUp ? 'up' : 'down',
      redis: 'not_configured',
    },
    timestamp: new Date().toISOString(),
  };

  res.status(databaseUp ? 200 : 503).json(body);
});
