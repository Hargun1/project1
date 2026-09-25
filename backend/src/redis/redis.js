import Redis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * Single Redis client for the process.
 *
 * Phase 2 uses it for refresh-token session storage.
 * Phase 8 adds a separate Pub/Sub subscriber (Pub/Sub requires dedicated connections).
 * Phase 11 adds rate-limit counters.
 *
 * `lazyConnect: true` lets us construct the client at module scope without
 * blocking startup; the first command triggers the actual connection.
 */
export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 200, 5000);
    logger.warn({ attempt: times, delayMs: delay }, 'redis reconnecting');
    return delay;
  },
});

redis.on('connect', () => logger.info('redis connected'));
redis.on('error', (err) => logger.error({ err }, 'redis error'));

/**
 * Readiness probe: PING round-trip.
 *
 * @returns {Promise<boolean>}
 */
export async function checkRedisConnection() {
  try {
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch (error) {
    logger.warn({ err: error }, 'Redis readiness check failed');
    return false;
  }
}

/**
 * Graceful shutdown — close the connection so the process does not hang.
 *
 * @returns {Promise<void>}
 */
export async function disconnectRedis() {
  await redis.quit();
}
