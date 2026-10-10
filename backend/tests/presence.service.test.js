import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import {
  applyClientAwareness,
  applyRemoteAwareness,
  createPresence,
  releaseConnectionPresence,
} from '../src/services/presence.service.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REMOTE = Symbol('redis');

/** A browser-side awareness for one tab, producing real encoded updates. */
function tab(name = 'Alice') {
  const awareness = new Awareness(new Y.Doc());
  awareness.setLocalState({ user: { id: USER, name, color: '#22c55e' } });
  const update = () => encodeAwarenessUpdate(awareness, [awareness.clientID]);
  return { awareness, update };
}

describe('presence ownership across instances', () => {
  it('a stale local socket does not delete a cursor that moved to another instance', () => {
    const presence = createPresence(new Y.Doc());
    const staleSocket = { userId: USER, userName: 'Alice' };
    const browser = tab();

    // The tab was connected here…
    expect(applyClientAwareness(presence, staleSocket, browser.update()).ok).toBe(true);

    // …then reconnected to another instance, which relays its newer state.
    browser.awareness.setLocalStateField('selection', null);
    applyRemoteAwareness(presence, browser.update(), REMOTE);

    // The old socket finally times out here. Its cleanup must not remove the
    // entry, or every instance would drop the user's live cursor.
    releaseConnectionPresence(presence, staleSocket);
    expect(presence.awareness.getStates().has(browser.awareness.clientID)).toBe(true);

    browser.awareness.destroy();
  });

  it('removes entries a closing socket still owns', () => {
    const presence = createPresence(new Y.Doc());
    const socket = { userId: USER, userName: 'Alice' };
    const browser = tab();

    applyClientAwareness(presence, socket, browser.update());
    releaseConnectionPresence(presence, socket);
    expect(presence.awareness.getStates().has(browser.awareness.clientID)).toBe(false);

    browser.awareness.destroy();
  });
});
