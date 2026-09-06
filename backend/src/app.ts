import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './config/env';
import { JSON_BODY_LIMIT } from './config/constants';
import { logger } from './utils/logger';
import { requestIdMiddleware } from './middleware/request-id';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { healthRouter } from './routes/health.routes';

/**
 * Builds the Express application.
 *
 * A factory rather than a module-level singleton so tests can create an app
 * without starting a listener, and so Phase 5 can attach a WebSocket server to
 * the same HTTP server in `server.ts`.
 *
 * Middleware order matters: identify the request, then log it, then parse a
 * bounded body, then route, and only then handle what fell through.
 */
export function createApp(): Express {
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
      genReqId: (req: IncomingMessage) =>
        (req as IncomingMessage & { requestId?: string }).requestId ?? randomUUID(),
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
