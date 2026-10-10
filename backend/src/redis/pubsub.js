import { EventEmitter } from 'node:events';
import { redis } from './redis.js';
import { logger } from '../utils/logger.js';

/**
 * The cross-instance message bus, backed by Redis Pub/Sub (§22).
 *
 * Interface (also implemented by the in-memory bus the tests use):
 *
 *   subscribe(channel, handler)  handler(rawMessage: string)
 *   unsubscribe(channel)
 *   publish(channel, rawMessage)
 *   state                        'up' | 'down'
 *   on('status', fn)             fn('up' | 'down') on every transition
 *   close()
 *
 * A subscribed Redis connection can do nothing but receive, so Pub/Sub needs a
 * dedicated connection; publishing reuses the shared client.
 *
 * What Pub/Sub does *not* give us: delivery guarantees. A message published
 * while this subscriber is disconnected is simply gone. Messages are not lost on
 * a healthy connection — Redis drops a slow subscriber by *disconnecting* it — so
 * every loss is followed by a reconnect, and the `'up'` event is the cue for the
 * collaboration layer to resynchronise. ioredis re-subscribes to every channel
 * by itself before it reports ready.
 */
export function createRedisBus() {
  const subscriber = redis.duplicate();
  const handlers = new Map();
  const events = new EventEmitter();
  let state = 'down';

  const setState = (next) => {
    if (next === state) return;
    state = next;
    logger[next === 'up' ? 'info' : 'warn']({ pubsub: next }, `redis pub/sub ${next}`);
    events.emit('status', next);
  };

  subscriber.on('ready', () => setState('up'));
  subscriber.on('close', () => setState('down'));
  subscriber.on('error', (err) => logger.debug({ err }, 'redis subscriber error'));
  subscriber.on('message', (channel, message) => {
    handlers.get(channel)?.(message);
  });

  // The shared client is created with lazyConnect, which the duplicate inherits.
  subscriber
    .connect()
    .catch((err) => logger.warn({ err }, 'redis subscriber initial connect failed'));

  return {
    get state() {
      return state;
    },
    on: (event, fn) => events.on(event, fn),
    off: (event, fn) => events.off(event, fn),

    async subscribe(channel, handler) {
      handlers.set(channel, handler);
      try {
        await subscriber.subscribe(channel);
      } catch (err) {
        handlers.delete(channel);
        throw err;
      }
    },

    async unsubscribe(channel) {
      handlers.delete(channel);
      try {
        await subscriber.unsubscribe(channel);
      } catch (err) {
        // Not subscribed any more anyway once the connection is gone.
        logger.debug({ err, channel }, 'redis unsubscribe failed');
      }
    },

    async publish(channel, message) {
      await redis.publish(channel, message);
    },

    async close() {
      handlers.clear();
      events.removeAllListeners();
      await subscriber.quit().catch(() => subscriber.disconnect());
    },
  };
}
