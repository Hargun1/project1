import { EventEmitter } from 'node:events';

/**
 * An in-process stand-in for Redis Pub/Sub, implementing the same interface as
 * `src/redis/pubsub.js`, so several collaboration hubs can run in one test
 * process.
 *
 * Like Redis, it is fire-and-forget: delivery is asynchronous, and while the
 * network is "down" publishes fail and messages already in flight are dropped.
 * That is exactly the failure the hubs' resync handshake must survive.
 */
export function createMemoryNetwork() {
  const buses = new Set();
  let up = true;

  function createBus() {
    const handlers = new Map();
    const events = new EventEmitter();

    const bus = {
      handlers,
      events,
      get state() {
        return up ? 'up' : 'down';
      },
      on: (event, fn) => events.on(event, fn),
      off: (event, fn) => events.off(event, fn),
      async subscribe(channel, handler) {
        if (!up) throw new Error('redis unavailable');
        handlers.set(channel, handler);
      },
      async unsubscribe(channel) {
        handlers.delete(channel);
      },
      /** Like Redis PUBLISH, resolves with the number of subscribers reached. */
      async publish(channel, message) {
        if (!up) throw new Error('redis unavailable');
        let receivers = 0;
        for (const peer of buses) {
          if (!peer.handlers.has(channel)) continue;
          receivers += 1;
          setImmediate(() => {
            if (up) peer.handlers.get(channel)?.(message);
          });
        }
        return receivers;
      },
      async close() {
        buses.delete(bus);
      },
    };
    buses.add(bus);
    return bus;
  }

  return {
    createBus,
    /** Simulate Redis going away (`false`) and coming back (`true`). */
    setUp(next) {
      up = next;
      for (const bus of buses) bus.events.emit('status', next ? 'up' : 'down');
    },
  };
}
