import WebSocket from 'ws';
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { colorForUser, fromBase64, toBase64, YDOC_TEXT_KEY } from '@collab/shared';

/**
 * A minimal Node implementation of the client half of the sync protocol — the
 * same steps `frontend/src/collaboration/collab-provider.js` performs, minus the
 * browser and Monaco. Tests use it to drive the real WebSocket server.
 */

const REMOTE = 'remote';

/**
 * @param {string} baseUrl  e.g. ws://127.0.0.1:1234/ws
 * @param {string} ticket
 * @param {Y.Doc} [ydoc]    pass an existing doc to simulate a reconnect
 * @param {Awareness} [awareness]  pass an existing one, too, for a presence reconnect
 */
export function connectClient(
  baseUrl,
  ticket,
  ydoc = new Y.Doc(),
  awareness = new Awareness(ydoc),
) {
  const ws = new WebSocket(`${baseUrl}?ticket=${encodeURIComponent(ticket)}`);
  const received = [];
  const waiters = [];
  let closeInfo = null;
  const closed = new Promise((resolve) => {
    ws.on('close', (code, reason) => {
      closeInfo = { code, reason: reason.toString() };
      resolve(closeInfo);
    });
  });

  const send = (payload) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  const onLocalUpdate = (update, origin) => {
    if (origin !== REMOTE) send({ type: 'update', update: toBase64(update) });
  };
  ydoc.on('update', onLocalUpdate);

  const onLocalAwareness = ({ added, updated, removed }, origin) => {
    if (origin === REMOTE) return;
    const changed = added.concat(updated, removed);
    send({ type: 'awareness', update: toBase64(encodeAwarenessUpdate(awareness, changed)) });
  };
  awareness.on('update', onLocalAwareness);

  ws.on('message', (data) => {
    const message = JSON.parse(data.toString());
    received.push(message);

    switch (message.type) {
      case 'joined':
        send({ type: 'sync-step1', stateVector: toBase64(Y.encodeStateVector(ydoc)) });
        // (Re)announce presence with the identity the server confirmed. Setting
        // the state bumps our clock, so peers accept it even after a removal.
        awareness.setLocalState({
          ...awareness.getLocalState(),
          user: {
            id: message.userId,
            name: message.userName,
            color: colorForUser(message.userId),
          },
        });
        break;
      case 'awareness':
        applyAwarenessUpdate(awareness, fromBase64(message.update), REMOTE);
        break;
      case 'sync-step1':
        send({
          type: 'sync-step2',
          update: toBase64(Y.encodeStateAsUpdate(ydoc, fromBase64(message.stateVector))),
        });
        break;
      case 'sync-step2':
      case 'update':
        Y.applyUpdate(ydoc, fromBase64(message.update), REMOTE);
        break;
      default:
        break;
    }

    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });

  /** Resolves with the first (past or future) message matching `predicate`. */
  const waitFor = (predicate, timeoutMs = 2000) => {
    const existing = received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
      waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
    });
  };

  return {
    ws,
    ydoc,
    text: ydoc.getText(YDOC_TEXT_KEY),
    awareness,
    /** Names of the *other* users this client currently sees. */
    peers: () =>
      [...awareness.getStates()]
        .filter(([id, state]) => id !== ydoc.clientID && state?.user)
        .map(([, state]) => state.user.name)
        .sort(),
    received,
    send,
    waitFor,
    closed,
    get closeInfo() {
      return closeInfo;
    },
    /** Resolves once the initial two-way handshake has completed. */
    synced: () => waitFor((m) => m.type === 'sync-step2'),
    /** Drop the socket but keep Y.Doc + Awareness, like a network blip. */
    disconnect() {
      ydoc.off('update', onLocalUpdate);
      awareness.off('update', onLocalAwareness);
      // Forget peers while offline; the server re-sends everyone on reconnect.
      const others = [...awareness.getStates().keys()].filter((id) => id !== ydoc.clientID);
      removeAwarenessStates(awareness, others, REMOTE);
      ws.close();
      return closed;
    },
    close() {
      ydoc.off('update', onLocalUpdate);
      awareness.off('update', onLocalAwareness);
      awareness.destroy();
      ws.close();
      return closed;
    },
  };
}

/** Poll until `check()` is truthy — for convergence that arrives over the network. */
export async function eventually(check, timeoutMs = 2000) {
  const started = Date.now();
  for (;;) {
    if (check()) return;
    if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
