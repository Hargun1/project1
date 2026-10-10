import { createApp } from './app.js';
import { env } from './config/env.js';
import { SERVICE_NAME, SERVICE_VERSION } from './config/constants.js';
import { logger } from './utils/logger.js';
import { disconnectDatabase } from './database/prisma.js';
import { hostname } from 'node:os';
import { disconnectRedis } from './redis/redis.js';
import { createRedisBus } from './redis/pubsub.js';
import { attachWebSocketServer, closeWebSocketServer } from './websocket/ws-server.js';
import { createCollaborationHub } from './services/collaboration.service.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

// Collaboration: one hub per process, linked to the other instances through
// Redis Pub/Sub. The instance id appears in logs, so a multi-instance demo can
// show which backend served which socket.
const bus = createRedisBus();
const hub = createCollaborationHub({ bus, instanceId: `${hostname()}:${env.PORT}` });
logger.info({ instance: hub.instanceId }, 'collaboration hub started');

const app = createApp({ hub });

const server = app.listen(env.PORT, () => {
  logger.info(
    { port: env.PORT, nodeEnv: env.NODE_ENV, service: SERVICE_NAME, version: SERVICE_VERSION },
    'backend listening',
  );
});

// The WebSocket server shares the HTTP server (and port) that Express uses.
const wss = attachWebSocketServer(server, { hub });

let shuttingDown = false;

/**
 * Graceful shutdown: close WebSocket connections, persist every open document,
 * stop accepting HTTP requests, release PostgreSQL and Redis, then exit.
 *
 * Order matters. Sockets close first so no new edits arrive; documents are
 * flushed while the database pool is still open; only then do the stores go.
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

  // 2. Persist unsaved document state while PostgreSQL is still reachable.
  try {
    await hub.flushAllSessions();
  } catch (error) {
    logger.error({ err: error }, 'error while flushing document state');
  }

  // 3. Stop accepting new HTTP connections.
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
      await bus.close();
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
