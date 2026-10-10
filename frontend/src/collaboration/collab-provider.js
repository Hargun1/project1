import * as Y from 'yjs';
import {
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import { colorForUser, fromBase64, isRole, toBase64 } from '@collab/shared';
import { createWsClient, WS_STATUS } from '../websocket/ws-client.js';

/**
 * Connects a local `Y.Doc` to the server's copy of the same document (§18, §21).
 *
 * This is a hand-rolled, deliberately small replacement for y-websocket's
 * provider — see docs/collaboration.md for why. The protocol:
 *
 *   joined      → send sync-step1 (our state vector)
 *   sync-step1  → reply sync-step2 with what the server is missing
 *   sync-step2  → apply: everything we were missing
 *   update      → apply: a collaborator's live edit
 *   local edit  → send update
 *   awareness   ⇄ presence: who is here and where their cursor is (Phase 7)
 *
 * Reconnection needs no special code path. While offline, local edits simply
 * stay in the Y.Doc (sends are dropped); on reconnect the same handshake runs
 * and the state vectors work out exactly what each side lacks — nothing is
 * lost and nothing is sent twice.
 */

/** Origin tag for updates that came from the server, so they are not echoed back. */
const REMOTE_ORIGIN = Symbol('remote');

/** What the UI shows for persistence (§44). */
export const SAVE_STATUS = {
  SAVED: 'saved',
  SAVING: 'saving',
  FAILED: 'failed',
  OFFLINE: 'offline',
};

/**
 * @param {object} options
 * @param {string} options.documentId
 * @param {Y.Doc} options.ydoc
 * @param {import('y-protocols/awareness').Awareness} options.awareness
 * @param {() => Promise<string>} options.getAccessToken
 * @param {(status: string, detail?: string) => void} options.onConnectionChange
 * @param {(status: string) => void} options.onSaveStatusChange
 * @param {(state: 'ok' | 'degraded') => void} options.onClusterChange
 * @param {(role: string) => void} options.onRoleChange  your role changed while connected
 * @param {() => void} options.onSynced  first time the document content has arrived
 * @param {(message: { code: string, message: string }) => void} options.onError
 * @returns {{ destroy: () => void }}
 */
export function createCollabProvider({
  documentId,
  ydoc,
  awareness,
  getAccessToken,
  onConnectionChange,
  onSaveStatusChange,
  onClusterChange,
  onRoleChange,
  onSynced,
  onError,
}) {
  let connected = false;
  let synced = false;
  let saveFailed = false;

  /** Highest clock of our *own* edits that the server reported as persisted. */
  let persistedOwnClock = ownClock();

  function ownClock() {
    return Y.decodeStateVector(Y.encodeStateVector(ydoc)).get(ydoc.clientID) ?? 0;
  }

  /**
   * "Saved" means: every edit *this client* made is in a state the server
   * confirmed it wrote to PostgreSQL. Comparing clocks makes that exact — a
   * `saved` message for an older state cannot hide a newer unsaved edit.
   */
  function reportSaveStatus() {
    if (!connected) {
      onSaveStatusChange(SAVE_STATUS.OFFLINE);
    } else if (persistedOwnClock >= ownClock()) {
      onSaveStatusChange(SAVE_STATUS.SAVED);
    } else {
      onSaveStatusChange(saveFailed ? SAVE_STATUS.FAILED : SAVE_STATUS.SAVING);
    }
  }

  const client = createWsClient({
    documentId,
    getAccessToken,
    onStatusChange: (status, detail) => {
      const wasConnected = connected;
      connected = status === WS_STATUS.CONNECTED;
      if (wasConnected && !connected) {
        // Offline we cannot know who is still here; showing stale cursors would
        // be a lie. The server sends everyone's presence again on reconnect.
        forgetPeers();
      }
      onConnectionChange(status, detail);
      reportSaveStatus();
    },
    onMessage: handleMessage,
  });

  function handleMessage(message) {
    switch (message.type) {
      case 'joined':
        client.send({ type: 'sync-step1', stateVector: toBase64(Y.encodeStateVector(ydoc)) });
        // Announce ourselves with the identity the *server* confirmed. The server
        // refuses any other name, so this cannot be spoofed from here anyway.
        awareness.setLocalState({
          ...awareness.getLocalState(),
          user: {
            id: message.userId,
            name: message.userName,
            color: colorForUser(message.userId),
          },
        });
        return;

      case 'awareness':
        applyAwarenessUpdate(awareness, fromBase64(message.update), REMOTE_ORIGIN);
        return;

      case 'sync-step1':
        client.send({
          type: 'sync-step2',
          update: toBase64(Y.encodeStateAsUpdate(ydoc, fromBase64(message.stateVector))),
        });
        return;

      case 'sync-step2':
        Y.applyUpdate(ydoc, fromBase64(message.update), REMOTE_ORIGIN);
        if (!synced) {
          synced = true;
          onSynced();
        }
        return;

      case 'update':
        Y.applyUpdate(ydoc, fromBase64(message.update), REMOTE_ORIGIN);
        return;

      case 'saved': {
        const persisted = Y.decodeStateVector(fromBase64(message.stateVector));
        persistedOwnClock = Math.max(persistedOwnClock, persisted.get(ydoc.clientID) ?? 0);
        saveFailed = false;
        reportSaveStatus();
        return;
      }

      case 'save-failed':
        saveFailed = true;
        reportSaveStatus();
        return;

      case 'role':
        // The server already enforces the new role; this only updates the UI
        // (for example, the editor becomes read-only after a downgrade).
        if (isRole(message.role)) onRoleChange(message.role);
        return;

      case 'cluster':
        onClusterChange(message.state === 'degraded' ? 'degraded' : 'ok');
        return;

      case 'error':
        onError({ code: message.code, message: message.message });
        return;

      default:
        return;
    }
  }

  function handleLocalUpdate(update, origin) {
    if (origin === REMOTE_ORIGIN) return;
    // If the socket is down this is a no-op; the reconnect handshake catches up.
    client.send({ type: 'update', update: toBase64(update) });
    reportSaveStatus();
  }
  ydoc.on('update', handleLocalUpdate);

  // Local presence changes: cursor moves (via y-monaco) and the 15 s keep-alive
  // renewal the Awareness class performs on its own.
  function handleLocalAwareness({ added, updated, removed }, origin) {
    if (origin === REMOTE_ORIGIN) return;
    const changed = added.concat(updated, removed);
    client.send({ type: 'awareness', update: toBase64(encodeAwarenessUpdate(awareness, changed)) });
  }
  awareness.on('update', handleLocalAwareness);

  function forgetPeers() {
    const others = [...awareness.getStates().keys()].filter((id) => id !== ydoc.clientID);
    removeAwarenessStates(awareness, others, REMOTE_ORIGIN);
  }

  return {
    destroy() {
      // Withdraw our presence while the socket is still open, so others drop
      // our cursor now (the server would also do it when the socket closes).
      awareness.setLocalState(null);
      awareness.off('update', handleLocalAwareness);
      ydoc.off('update', handleLocalUpdate);
      client.disconnect();
    },
  };
}
