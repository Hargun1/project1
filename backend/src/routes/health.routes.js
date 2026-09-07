import { Router } from 'express';
import { SERVICE_NAME, SERVICE_VERSION } from '../config/constants.js';
import { checkDatabaseConnection } from '../database/prisma.js';

export const healthRouter = Router();

/**
 * Liveness. Touches nothing external on purpose: a dependency blip must not make
 * the load balancer kill an otherwise healthy process.
 *
 * Response shape is documented in `shared/src/health.js`.
 */
healthRouter.get('/healthz', (_req, res) => {
  res.json({
    status: 'ok',
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Readiness. Verifies the dependencies this instance needs to serve traffic, so
 * Nginx can route around a degraded instance (§6, §35).
 *
 * Answers 503 when degraded but still returns a *valid* body, because "which
 * dependency is down" is exactly what a caller needs to know.
 *
 * Redis reports `not_configured` until Phase 8 connects it — an honest signal
 * rather than a check that pretends to pass.
 */
healthRouter.get('/readyz', async (_req, res) => {
  const databaseUp = await checkDatabaseConnection();

  res.status(databaseUp ? 200 : 503).json({
    status: databaseUp ? 'ready' : 'degraded',
    checks: {
      database: databaseUp ? 'up' : 'down',
      redis: 'not_configured',
    },
    timestamp: new Date().toISOString(),
  });
});
