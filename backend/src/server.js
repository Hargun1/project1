import { createApp } from './app.js';
import { env } from './config/env.js';
import { SERVICE_NAME, SERVICE_VERSION } from './config/constants.js';
import { logger } from './utils/logger.js';
import { disconnectDatabase } from './database/prisma.js';
import { disconnectRedis } from './redis/redis.js';
import { attachWebSocketServer, closeWebSocketServer } from './websocket/ws-server.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, nodeEnv: env.NODE_ENV, service: SERVICE_NAME, version: SERVICE_VERSION },
    'backend listening',
  );
});

// ── Phase 5: attach WebSocket server to the same HTTP server ─────────────
const wss = attachWebSocketServer(server);

let shuttingDown = false;

/**
 * Graceful shutdown: close WebSocket connections, stop accepting HTTP requests,
 * release the PostgreSQL pool and Redis connection, then exit.
 *
 * WebSocket connections are closed first so that in-flight collaboration
 * messages drain before the data stores go away.
 *
 * @param {string} signal
 * @returns {Promise<void>}
 */
async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  const forceExit = setTimeout(() => {
    logger.error({ signal }, 'graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // 1. Close all WebSocket connections with a SERVER_SHUTDOWN code.
  try {
    await closeWebSocketServer(wss);
  } catch (error) {
    logger.error({ err: error }, 'error while closing WebSocket server');
  }

  // 2. Stop accepting new HTTP connections.
  server.close(async (closeError) => {
    if (closeError) {
      logger.error({ err: closeError }, 'error while closing HTTP server');
    }
    try {
      await disconnectDatabase();
    } catch (error) {
      logger.error({ err: error }, 'error while disconnecting from PostgreSQL');
    }
    try {
      await disconnectRedis();
    } catch (error) {
      logger.error({ err: error }, 'error while disconnecting from Redis');
    }
    clearTimeout(forceExit);
    process.exit(closeError ? 1 : 0);
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  void shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'uncaught exception');
  void shutdown('uncaughtException');
});
