import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { JSON_BODY_LIMIT } from './config/constants.js';
import { logger } from './utils/logger.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.routes.js';

/**
 * Builds the Express application.
 *
 * A factory rather than a module-level singleton so tests can create an app
 * without starting a listener, and so Phase 5 can attach a WebSocket server to
 * the same HTTP server in `server.js`.
 *
 * Middleware order matters: identify the request, then log it, then parse a
 * bounded body, then route, and only then handle what fell through.
 *
 * @returns {import('express').Express}
 */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // One reverse proxy (Nginx) sits in front in production — needed for correct
  // client IPs, which rate limiting depends on from Phase 11.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_URL, credentials: true }));

  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.requestId ?? randomUUID(),
      // Probes fire constantly behind a load balancer; logging them buries real traffic.
      autoLogging: {
        ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
      },
    }),
  );

  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: JSON_BODY_LIMIT }));

  app.use(healthRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
