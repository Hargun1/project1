/**
 * Token bucket: `capacity` tokens, refilled continuously at `refillPerSecond`.
 * Each message takes one token; with none left the message is over the limit.
 *
 * Unlike a fixed window it allows short bursts (typing fast, a big paste that
 * Yjs splits into several updates) while capping the *sustained* rate. Used
 * per WebSocket connection, in memory: a socket lives on one process, so no
 * shared store is needed.
 *
 * @param {{ capacity: number, refillPerSecond: number, now?: () => number }} options
 */
export function createTokenBucket({ capacity, refillPerSecond, now = () => Date.now() }) {
  let tokens = capacity;
  let last = now();

  return {
    /** @returns {boolean} true if a token was available (and is now spent) */
    take() {
      const t = now();
      tokens = Math.min(capacity, tokens + ((t - last) / 1000) * refillPerSecond);
      last = t;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
