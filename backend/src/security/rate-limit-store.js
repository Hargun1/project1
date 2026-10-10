import { logger } from '../utils/logger.js';

/**
 * Counters for fixed-window rate limiting (§28).
 *
 * Interface: `hit(key, windowMs)` → `{ count, resetMs }`: count this request in
 * the current window and report how many requests the window has seen so far and
 * how long until it resets.
 *
 * Fixed window: the first hit creates a counter that expires after `windowMs`;
 * every hit increments it. Simple and cheap (one key per client per window). Its
 * known weakness: a client can send `limit` requests at the end of one window and
 * `limit` more at the start of the next, so a short burst can reach 2× the limit.
 * Sliding windows or token buckets smooth that out; for login protection the
 * fixed window is a standard, explainable choice.
 */

/**
 * Redis-backed: every backend instance shares the same counters, so a client
 * cannot multiply its allowance by hitting different instances.
 *
 * INCR and PEXPIRE ... NX run in one MULTI transaction: the expiry is set only by
 * the first hit of a window (NX = only if no expiry exists), and no other command
 * can interleave between them.
 *
 * @param {import('ioredis').Redis} redis
 */
export function createRedisRateLimitStore(redis) {
  return {
    async hit(key, windowMs) {
      const results = await redis.multi().incr(key).pexpire(key, windowMs, 'NX').pttl(key).exec();
      const failed = results.find(([err]) => err);
      if (failed) throw failed[0];
      const count = results[0][1];
      const ttl = results[2][1];
      return { count, resetMs: ttl > 0 ? ttl : windowMs };
    },
  };
}

/**
 * In-process counters. Used by tests and as the default when no store is given;
 * correct for a single instance only (each process would count separately).
 *
 * @param {() => number} [now]  clock, injectable for tests
 */
export function createMemoryRateLimitStore(now = () => Date.now()) {
  const windows = new Map();
  let hits = 0;

  return {
    async hit(key, windowMs) {
      const t = now();
      let window = windows.get(key);
      if (!window || window.resetAt <= t) {
        window = { count: 0, resetAt: t + windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      // Occasionally drop expired windows so the map cannot grow forever.
      hits += 1;
      if (hits % 1_000 === 0) {
        for (const [k, w] of windows) if (w.resetAt <= t) windows.delete(k);
      }
      return { count: window.count, resetMs: window.resetAt - t };
    },
  };
}

/** Logged once per failure burst, not per request. */
let lastStoreWarning = 0;
export function warnStoreUnavailable(err) {
  if (Date.now() - lastStoreWarning > 10_000) {
    lastStoreWarning = Date.now();
    logger.warn({ err }, 'rate limit store unavailable — allowing requests (fail open)');
  }
}
