import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env } from './config/env.js';
import { JSON_BODY_LIMIT } from './config/constants.js';
import { logger } from './utils/logger.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { healthRouter } from './routes/health.routes.js';
import { createAuthRouter } from './routes/auth.routes.js';
import { createDocumentRouter } from './routes/document.routes.js';
import { rateLimit } from './middleware/rate-limit.js';
import { requireTrustedOrigin } from './middleware/trusted-origin.js';
import { createMemoryRateLimitStore } from './security/rate-limit-store.js';
import { originOf } from './security/origin.js';
import { attachFrontend } from './frontend.js';

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
 * @param {object} [deps]
 * @param {object} [deps.hub]  collaboration hub; needed by the revision routes that
 *   act on the live document (restore, save version). Tests that do not touch
 *   those routes can omit it.
 * @param {object} [deps.rateLimitStore]  counters for rate limiting. `server.js`
 *   passes the Redis store so limits are shared by all instances; the in-memory
 *   default is per process and meant for tests.
 * @returns {import('express').Express}
 */
export function createApp({ hub, rateLimitStore = createMemoryRateLimitStore() } = {}) {
  const app = express();
  app.locals.hub = hub ?? null;

  app.disable('x-powered-by');
  // Reverse proxies in front (Nginx = 1). Decides `req.ip`, which rate limiting
  // keys on; the WebSocket upgrade handler uses the same number (security/origin.js).
  app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(helmet());
  app.use(cors({ origin: env.CLIENT_URL, credentials: true }));

  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.requestId ?? randomUUID(),
      // One compact line per request (Phase 12). The defaults log every request
      // and response header — kilobytes per line in production, mostly noise,
      // and each extra field is one more place a secret could leak. `ip` is the
      // client address resolved through the trusted proxy, not Nginx's.
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url, ip: req.raw.ip }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
      // Evaluated again when the response finishes, after `authenticate` has run.
      customProps: (req) => ({ userId: req.user?.id }),
      // Probes fire constantly behind a load balancer; logging them buries real traffic.
      autoLogging: {
        ignore: (req) => req.url === '/healthz' || req.url === '/readyz',
      },
    }),
  );

  // Parse cookies before routes so `req.cookies` is available (refresh token).
  app.use(cookieParser());
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: JSON_BODY_LIMIT }));

  // API responses can contain private documents and tokens: never cache them
  // in browsers or shared proxies.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // ── Rate limits (Phase 11, §28) ──────────────────────────────────────────
  const minute = 60_000;
  const perIp = rateLimit({
    store: rateLimitStore,
    name: 'auth-ip',
    limit: env.RATE_LIMIT_AUTH_PER_MINUTE,
    windowMs: minute,
    key: (req) => req.ip,
  });
  const perEmail = rateLimit({
    store: rateLimitStore,
    name: 'login-email',
    limit: env.RATE_LIMIT_LOGIN_PER_EMAIL,
    windowMs: 15 * minute,
    // Same normalisation as the login schema; skipped if there is no email
    // (validation will reject the request anyway).
    key: (req) =>
      typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() || null : null,
  });
  const perUser = rateLimit({
    store: rateLimitStore,
    name: 'api-user',
    limit: env.RATE_LIMIT_API_PER_MINUTE,
    windowMs: minute,
    key: (req) => req.user?.id ?? req.ip,
  });

  app.use(healthRouter);
  app.use(
    '/api/auth',
    createAuthRouter({
      trustedOrigin: requireTrustedOrigin([originOf(env.CLIENT_URL)]),
      perIp,
      perEmail,
    }),
  );
  app.use('/api/documents', createDocumentRouter({ perUser }));

  if (env.SERVE_FRONTEND) attachFrontend(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
