import { Router } from 'express';
import { SERVICE_NAME, SERVICE_VERSION } from '../config/constants.js';
import { checkDatabaseConnection } from '../database/prisma.js';
import { checkRedisConnection } from '../redis/redis.js';

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
 * Also 503 (`draining`) once graceful shutdown has begun (Phase 12): the process
 * is still alive and finishing its work, but a load balancer polling readiness
 * must stop sending it new requests. `server.js` sets `app.locals.draining`.
 */
healthRouter.get('/readyz', async (req, res) => {
  const [databaseUp, redisUp] = await Promise.all([
    checkDatabaseConnection(),
    checkRedisConnection(),
  ]);

  const draining = req.app.locals.draining === true;
  const ready = databaseUp && redisUp && !draining;

  let status = 'ready';
  if (draining) status = 'draining';
  else if (!ready) status = 'degraded';

  res.status(ready ? 200 : 503).json({
    status,
    checks: {
      database: databaseUp ? 'up' : 'down',
      redis: redisUp ? 'up' : 'down',
    },
    timestamp: new Date().toISOString(),
  });
});
