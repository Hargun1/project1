import { AppError } from '../utils/app-error.js';
import { warnStoreUnavailable } from '../security/rate-limit-store.js';

/**
 * Express rate-limiting middleware (§28).
 *
 * @param {object} options
 * @param {{ hit(key: string, windowMs: number): Promise<{ count: number, resetMs: number }> }} options.store
 * @param {string} options.name          bucket name, part of the counter key
 * @param {number} options.limit         requests allowed per window
 * @param {number} options.windowMs
 * @param {(req) => string | null} options.key  who is counted; null = skip this request
 *
 * Every response carries the IETF draft `RateLimit-*` headers, so a well-behaved
 * client can slow down before it is refused; a refusal is a 429 with
 * `Retry-After`, in the shared error envelope.
 *
 * **Fails open:** if the store (Redis) is unreachable, requests are allowed and a
 * warning is logged. Refusing all traffic because the limiter is down would turn
 * a Redis outage into a full API outage. The trade-off is that limits are not
 * enforced during that outage.
 */
export function rateLimit({ store, name, limit, windowMs, key }) {
  return async (req, res, next) => {
    const identity = key(req);
    if (!identity) return next();

    let result;
    try {
      result = await store.hit(`rl:${name}:${identity}`, windowMs);
    } catch (err) {
      warnStoreUnavailable(err);
      return next();
    }

    const resetSeconds = Math.max(1, Math.ceil(result.resetMs / 1000));
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - result.count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (result.count > limit) {
      res.setHeader('Retry-After', String(resetSeconds));
      throw AppError.rateLimited(`Too many requests. Try again in ${resetSeconds} seconds.`);
    }
    return next();
  };
}
