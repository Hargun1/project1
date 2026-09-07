import { createApp } from './app.js';
import { env } from './config/env.js';
import { SERVICE_NAME, SERVICE_VERSION } from './config/constants.js';
import { logger } from './utils/logger.js';
import { disconnectDatabase } from './database/prisma.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, nodeEnv: env.NODE_ENV, service: SERVICE_NAME, version: SERVICE_VERSION },
    'backend listening',
  );
});

let shuttingDown = false;

/**
 * Graceful shutdown: stop accepting connections, release the PostgreSQL pool,
 * then exit. Phase 5 will also close WebSocket connections here, and Phase 12
 * relies on this so a rolling restart does not drop in-flight requests.
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

  server.close(async (closeError) => {
    if (closeError) {
      logger.error({ err: closeError }, 'error while closing HTTP server');
    }
    try {
      await disconnectDatabase();
    } catch (error) {
      logger.error({ err: error }, 'error while disconnecting from PostgreSQL');
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
