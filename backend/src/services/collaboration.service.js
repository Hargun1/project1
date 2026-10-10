import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as Y from 'yjs';
import { encodeAwarenessUpdate } from 'y-protocols/awareness';
import { fromBase64, toBase64, YDOC_TEXT_KEY } from '@collab/shared';
import * as defaultRepo from '../repositories/document.repository.js';
import { env } from '../config/env.js';
import {
  DOC_SAVE_RETRY_MS,
  DOC_SNAPSHOT_MAX_WAIT_MS,
  PEER_SYNC_TIMEOUT_MS,
} from '../config/constants.js';
import {
  ACCESS_CHANNEL,
  BUS_PROTOCOL_VERSION,
  documentChannel,
  parseAccessMessage,
  parseBusMessage,
} from '../redis/bus-messages.js';
import { logger as defaultLogger } from '../utils/logger.js';
import {
  applyRemoteAwareness,
  createPresence,
  destroyPresence,
  encodeLocalAwareness,
} from './presence.service.js';
import { recordRevision, replaceText, revisionDecided, textOfState } from './revision.service.js';

/**
 * Collaboration hub: one `Y.Doc` per *open* document, kept in sync across
 * backend instances (§18, §22–§24, §36).
 *
 * The server keeps its own copy of every open document's CRDT state, rather than
 * only relaying bytes between browsers, because:
 *
 *   1. A client that joins late, or reconnects, needs someone to sync from even
 *      when no other browser is online.
 *   2. Persistence needs the merged state.
 *   3. It is where authorisation lives: a VIEWER's update is refused before it
 *      reaches anyone else.
 *
 * Lifecycle of a session:
 *
 *   acquire ─▶ subscribe to document:<id> ─▶ load yjs_state ─▶ hello to peers
 *           ─▶ edits: forward to local sockets, publish to Redis, debounced save
 *   release ─▶ last local connection gone ─▶ save now ─▶ unsubscribe, evict
 *
 * ── Several instances (Phase 8) ─────────────────────────────────────────────
 *
 * Each instance holds its own Y.Doc for a document its clients have open.
 * Local updates are published to Redis; updates from other instances are applied
 * with REDIS_ORIGIN, which forwards them to local sockets but never republishes
 * them. Because CRDT updates commute and are idempotent, instances converge no
 * matter the order or duplication of delivery.
 *
 * Redis Pub/Sub is fire-and-forget, so convergence cannot depend on it
 * delivering everything. Two mechanisms close the gaps:
 *
 *   - Handshake on (re)subscribe. A new session, and every session after the
 *     Redis connection recovers, broadcasts its state vector ("hello"). Peers
 *     reply with exactly what it is missing and ask for what they are missing —
 *     the same step-1/step-2 exchange browsers use.
 *   - Merge-on-save. Persisting locks the row, merges the stored state with ours
 *     and writes the union. Two instances that diverged while Redis was down
 *     therefore cannot overwrite each other's edits in PostgreSQL. Every instance
 *     saves what it has (including updates it received from peers), so a crash
 *     of the instance where an edit was typed does not lose it either.
 *
 * Redis is never the source of truth: if it disappears, editing continues per
 * instance (clients are told the cluster is degraded), PostgreSQL keeps the union
 * of everything, and the handshake reconciles live state once Redis is back.
 */

const LOAD_ORIGIN = Symbol('load');
const REDIS_ORIGIN = Symbol('redis');
const RESTORE_ORIGIN = Symbol('restore');

/**
 * @typedef {object} Session
 * @property {string} documentId
 * @property {Y.Doc} ydoc
 * @property {EventEmitter} events  'saved' (stateVector) | 'save-failed'
 * @property {ReturnType<typeof createPresence>} presence
 * @property {Promise<void>} ready
 * @property {number} refs
 * @property {boolean} dirty
 * @property {number | null} firstDirtyAt
 * @property {NodeJS.Timeout | null} timer
 * @property {Promise<void> | null} saving
 * @property {boolean} saveQueued
 * @property {string | null} lastEditorId  credited on automatic revisions
 * @property {boolean} needsCheckpoint  edited since the last revision decision
 * @property {{ remaining: number, done: () => void } | null} awaitingPeers
 */

/**
 * Merge two full Yjs states into one, garbage-collected.
 *
 * Going through a temporary Y.Doc (instead of `Y.mergeUpdates`) re-encodes with
 * GC, so content deleted in either copy does not accumulate in the stored blob.
 */
function mergeStates(stored, ours) {
  if (!stored) return ours;
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, stored);
    Y.applyUpdate(doc, ours);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/**
 * @param {object} [options]
 * @param {object | null} [options.bus]  cross-instance bus (see redis/pubsub.js); null = single instance
 * @param {string} [options.instanceId]
 * @param {typeof defaultRepo} [options.repo]
 * @param {import('pino').Logger} [options.logger]
 */
export function createCollaborationHub({
  bus = null,
  instanceId = randomUUID(),
  repo = defaultRepo,
  logger = defaultLogger,
} = {}) {
  /** @type {Map<string, Session>} */
  const sessions = new Map();
  const events = new EventEmitter();
  // Every open socket listens for 'cluster' and the WebSocket layer for
  // 'access-changed'; each listener is removed when its socket closes, so the
  // default limit of 10 (a leak *warning*, not a limit) does not apply here.
  events.setMaxListeners(0);
  let clusterState = !bus || bus.state === 'up' ? 'ok' : 'degraded';

  // ── Bus plumbing ─────────────────────────────────────────────────────────

  function publish(session, type, data, to = null) {
    if (!bus) return;
    const message = JSON.stringify({
      v: BUS_PROTOCOL_VERSION,
      from: instanceId,
      to,
      type,
      data: toBase64(data),
    });
    // A failed publish is not retried: the handshake after Redis recovers
    // delivers whatever this message carried.
    bus.publish(documentChannel(session.documentId), message).catch((err) => {
      logger.debug({ err, documentId: session.documentId, type }, 'publish failed');
    });
  }

  function hello(session) {
    publish(session, 'sync-step1', Y.encodeStateVector(session.ydoc));
  }

  /**
   * Hello, then wait until every peer that has this document open has sent what
   * we lack. PostgreSQL can be up to DOC_SNAPSHOT_MAX_WAIT_MS behind a peer's
   * memory; without this wait a client joining here — or a restore or "save
   * version" executed here — would act on stale content.
   *
   * PUBLISH returns how many subscribers received the message (us included), so
   * we know how many replies to expect. A slow peer cannot stall us beyond
   * PEER_SYNC_TIMEOUT_MS; its reply still applies whenever it arrives.
   */
  async function catchUpWithPeers(session) {
    if (!bus) return;
    const message = JSON.stringify({
      v: BUS_PROTOCOL_VERSION,
      from: instanceId,
      to: null,
      type: 'sync-step1',
      data: toBase64(Y.encodeStateVector(session.ydoc)),
    });
    const receivers = await bus.publish(documentChannel(session.documentId), message);
    const peers = Math.max(0, (Number(receivers) || 0) - 1);
    if (peers === 0) return;
    await new Promise((resolve) => {
      const timer = setTimeout(done, PEER_SYNC_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        session.awaitingPeers = null;
        resolve();
      }
      session.awaitingPeers = { remaining: peers, done };
    });
  }

  function handleBusMessage(session, raw) {
    const message = parseBusMessage(raw);
    if (!message) {
      logger.warn({ documentId: session.documentId }, 'ignoring malformed bus message');
      return;
    }
    // Redis echoes our own publishes back to us; messages for a peer are not ours.
    if (message.from === instanceId) return;
    if (message.to !== null && message.to !== instanceId) return;

    const data = fromBase64(message.data);
    switch (message.type) {
      case 'update':
      case 'sync-step2':
        try {
          Y.decodeUpdate(data);
        } catch {
          logger.warn({ documentId: session.documentId }, 'ignoring undecodable bus update');
          return;
        }
        Y.applyUpdate(session.ydoc, data, REDIS_ORIGIN);
        if (message.type === 'sync-step2' && message.to === instanceId && session.awaitingPeers) {
          session.awaitingPeers.remaining -= 1;
          if (session.awaitingPeers.remaining === 0) session.awaitingPeers.done();
        }
        return;

      case 'awareness':
        applyRemoteAwareness(session.presence, data, REDIS_ORIGIN);
        return;

      case 'sync-step1': {
        let missing;
        try {
          missing = Y.encodeStateAsUpdate(session.ydoc, data);
        } catch {
          return;
        }
        publish(session, 'sync-step2', missing, message.from);
        // A hello means a peer just (re)joined: also ask it for what *we* lack,
        // and tell it who is connected here. Targeted replies are never
        // answered with another step 1, so the exchange cannot loop.
        if (message.to === null) {
          publish(session, 'sync-step1', Y.encodeStateVector(session.ydoc), message.from);
          const local = encodeLocalAwareness(session.presence);
          if (local) publish(session, 'awareness', local, message.from);
        }
        return;
      }

      default:
        return;
    }
  }

  // ── Access changes (Phase 10) ────────────────────────────────────────────
  // A role change, removal or deletion on any instance makes every instance
  // emit 'access-changed' locally; the WebSocket layer re-checks the matching
  // sockets against PostgreSQL.
  if (bus) {
    bus
      .subscribe(ACCESS_CHANNEL, (raw) => {
        const message = parseAccessMessage(raw);
        if (!message || message.from === instanceId) return;
        events.emit('access-changed', { documentId: message.documentId, userId: message.userId });
      })
      .catch((err) => logger.error({ err }, 'could not subscribe to access changes'));
  }

  if (bus) {
    bus.on('status', (state) => {
      clusterState = state === 'up' ? 'ok' : 'degraded';
      events.emit('cluster', clusterState);
      if (state === 'up') {
        // Anything published while we were disconnected is gone. Ask for it.
        for (const session of sessions.values()) hello(session);
      }
    });
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  function createSession(documentId) {
    const ydoc = new Y.Doc({ gc: true });

    /** @type {Session} */
    const session = {
      documentId,
      ydoc,
      events: new EventEmitter(),
      presence: createPresence(ydoc),
      ready: Promise.resolve(),
      refs: 0,
      dirty: false,
      firstDirtyAt: null,
      timer: null,
      saving: null,
      saveQueued: false,
      lastEditorId: null,
      needsCheckpoint: false,
      awaitingPeers: null,
    };

    session.ready = (async () => {
      // Subscribe *before* loading, so no update published by a peer can fall
      // into the gap between reading PostgreSQL and listening to Redis.
      if (bus) {
        await bus.subscribe(documentChannel(documentId), (raw) => handleBusMessage(session, raw));
      }
      try {
        const state = await repo.getDocumentState(documentId);
        if (state) Y.applyUpdate(ydoc, state, LOAD_ORIGIN);
      } catch (err) {
        if (bus) await bus.unsubscribe(documentChannel(documentId));
        throw err;
      }

      ydoc.on('update', (update, origin) => {
        if (origin === LOAD_ORIGIN) return;
        markDirty(session);
        if (origin !== REDIS_ORIGIN) publish(session, 'update', update);
      });
      session.presence.awareness.on('update', ({ added, updated, removed }, origin) => {
        // Peers run their own 30 s timeouts; relaying ours would be noise.
        if (origin === REDIS_ORIGIN || origin === 'timeout') return;
        const changed = added.concat(updated, removed);
        publish(session, 'awareness', encodeAwarenessUpdate(session.presence.awareness, changed));
      });

      await catchUpWithPeers(session);
    })();

    return session;
  }

  function markDirty(session) {
    session.dirty = true;
    session.needsCheckpoint = true;
    session.firstDirtyAt ??= Date.now();
    scheduleSave(session, env.DOC_SNAPSHOT_DEBOUNCE_MS);
  }

  /**
   * (Re)arm the save timer. Each edit pushes the save back by the debounce
   * interval, but never past `firstDirtyAt + DOC_SNAPSHOT_MAX_WAIT_MS`.
   */
  function scheduleSave(session, delayMs) {
    if (session.timer) clearTimeout(session.timer);
    const deadline = (session.firstDirtyAt ?? Date.now()) + DOC_SNAPSHOT_MAX_WAIT_MS;
    const delay = Math.max(0, Math.min(delayMs, deadline - Date.now()));
    session.timer = setTimeout(() => {
      session.timer = null;
      void save(session);
    }, delay);
  }

  /**
   * One save: merge our full CRDT state into PostgreSQL under the row lock, and
   * let `recordRevision` decide whether it becomes a revision. Resolves with the
   * revision result (null when no revision was due).
   */
  function runSave(session, revisionRequest) {
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
    // Snapshot synchronously: edits arriving during the write get their own save.
    const state = Y.encodeStateAsUpdate(session.ydoc);
    const stateVector = Y.encodeStateVector(session.ydoc);
    session.dirty = false;
    session.firstDirtyAt = null;

    return repo
      .withLockedDocumentState(session.documentId, async (ops) => {
        const merged = mergeStates(ops.current, state);
        await ops.writeState(merged);
        return recordRevision(ops, merged, revisionRequest);
      })
      .then((result) => {
        if (revisionDecided(revisionRequest, result)) session.needsCheckpoint = false;
        logger.debug({ documentId: session.documentId, bytes: state.byteLength }, 'state saved');
        // The stored state now contains at least `stateVector`.
        session.events.emit('saved', stateVector);
        return result;
      });
  }

  /**
   * Automatic (debounced) save. Saves for one document never overlap within an
   * instance — a request mid-save is queued — and across instances the row
   * lock serialises them.
   */
  function save(session) {
    if (session.saving) {
      session.saveQueued = true;
      return session.saving;
    }
    // Everyone on this instance has left: if anything was edited since the last
    // revision decision, write once more so the session ends with a checkpoint —
    // even when the debounced save already persisted the final state.
    const endOfSession = session.refs === 0 && session.needsCheckpoint;
    if (!session.dirty && !endOfSession) {
      maybeEvict(session);
      return Promise.resolve();
    }

    session.saving = runSave(session, {
      kind: 'AUTO',
      createdById: session.lastEditorId,
      // Everyone on this instance has left: end the session with a checkpoint.
      ignoreInterval: session.refs === 0,
    })
      .then(() => {})
      .catch((err) => {
        logger.error({ err, documentId: session.documentId }, 'document state save failed');
        session.dirty = true;
        session.firstDirtyAt ??= Date.now();
        session.events.emit('save-failed');
        scheduleSave(session, DOC_SAVE_RETRY_MS);
      })
      .finally(() => {
        session.saving = null;
        if (session.saveQueued) {
          session.saveQueued = false;
          void save(session);
        } else {
          maybeEvict(session);
        }
      });

    return session.saving;
  }

  /**
   * A save whose result the caller awaits (manual revision, restore). Waits for
   * any in-flight save so writes stay ordered, then always writes: even with
   * nothing dirty, a revision may be wanted.
   */
  async function saveNow(session, revisionRequest) {
    while (session.saving) await session.saving;
    const promise = runSave(session, revisionRequest);
    session.saving = promise.then(
      () => {},
      () => {},
    );
    try {
      return await promise;
    } catch (err) {
      session.dirty = true;
      session.firstDirtyAt ??= Date.now();
      session.events.emit('save-failed');
      scheduleSave(session, DOC_SAVE_RETRY_MS);
      throw err;
    } finally {
      session.saving = null;
      if (session.saveQueued) {
        session.saveQueued = false;
        void save(session);
      }
    }
  }

  /** Run `fn` with the document's session, opening and closing it as needed. */
  async function withSession(documentId, fn) {
    const session = await api.acquireSession(documentId);
    try {
      return await fn(session);
    } finally {
      api.releaseSession(session);
    }
  }

  function maybeEvict(session) {
    const idle =
      session.refs === 0 &&
      !session.dirty &&
      !session.needsCheckpoint &&
      !session.saving &&
      !session.timer;
    if (idle && sessions.get(session.documentId) === session) {
      sessions.delete(session.documentId);
      if (bus) void bus.unsubscribe(documentChannel(session.documentId));
      session.events.removeAllListeners();
      destroyPresence(session.presence);
      session.ydoc.destroy();
      logger.debug({ documentId: session.documentId }, 'collaboration session evicted');
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────

  const api = {
    instanceId,
    events,

    /**
     * Someone's access to a document changed (role changed, member removed, or
     * the document deleted when `userId` is null). Re-check affected sockets
     * here and on every other instance.
     *
     * @param {string} documentId
     * @param {string | null} userId
     */
    notifyAccessChanged(documentId, userId) {
      events.emit('access-changed', { documentId, userId });
      if (!bus) return;
      const message = JSON.stringify({
        v: BUS_PROTOCOL_VERSION,
        from: instanceId,
        documentId,
        userId,
      });
      // If this is lost (Redis down), the periodic re-check still catches it.
      bus.publish(ACCESS_CHANNEL, message).catch((err) => {
        logger.warn({ err, documentId }, 'could not publish access change');
      });
    },

    /** 'ok' | 'degraded' — whether edits currently reach other instances. */
    get clusterState() {
      return clusterState;
    },

    /**
     * Get the session for a document, loading it if this is the first local
     * connection. Concurrent callers share one load.
     *
     * @param {string} documentId
     * @returns {Promise<Session>}
     * @throws when the state cannot be loaded or the channel cannot be subscribed
     */
    async acquireSession(documentId) {
      let session = sessions.get(documentId);
      if (!session) {
        session = createSession(documentId);
        sessions.set(documentId, session);
        const created = session;
        // A failed load must not be cached; the next connection retries.
        created.ready.catch(() => {
          if (sessions.get(documentId) === created) {
            sessions.delete(documentId);
            destroyPresence(created.presence);
          }
        });
      }
      session.refs += 1;
      try {
        await session.ready;
      } catch (err) {
        session.refs -= 1;
        throw err;
      }
      return session;
    },

    /** The last local connection leaving forces an immediate save. */
    releaseSession(session) {
      session.refs = Math.max(0, session.refs - 1);
      if (session.refs === 0) void save(session);
    },

    /**
     * Apply an update received from a client. Decoded fully *before* it is
     * applied, so a corrupt payload never touches the shared document.
     *
     * @returns {boolean} false when the payload is not a valid Yjs update
     */
    applyClientUpdate(session, update, origin) {
      try {
        Y.decodeUpdate(update);
      } catch {
        return false;
      }
      Y.applyUpdate(session.ydoc, update, origin);
      if (typeof origin?.userId === 'string') session.lastEditorId = origin.userId;
      return true;
    },

    /**
     * "Save version": persist now and record a MANUAL revision of the current
     * content (or return the latest one if the content has not changed).
     *
     * @returns {Promise<{ revision: object, created: boolean }>}
     */
    createRevision(documentId, userId) {
      return withSession(documentId, (session) =>
        saveNow(session, { kind: 'MANUAL', createdById: userId }),
      );
    },

    /**
     * Restore an older revision (§25): read its text from a fresh Y.Doc, rewrite
     * the live document to match with ordinary CRDT operations — so connected
     * clients on every instance receive a normal update — then persist the
     * result as a new RESTORE revision. Nothing in history is modified.
     *
     * @param {string} documentId
     * @param {{ revisionNumber: number, snapshot: Uint8Array }} target
     * @param {string} userId
     * @returns {Promise<{ revision: object, created: boolean }>}
     */
    restoreRevision(documentId, target, userId) {
      return withSession(documentId, async (session) => {
        replaceText(
          session.ydoc.getText(YDOC_TEXT_KEY),
          textOfState(target.snapshot),
          RESTORE_ORIGIN,
        );
        return saveNow(session, {
          kind: 'RESTORE',
          createdById: userId,
          restoredFromNumber: target.revisionNumber,
        });
      });
    },

    /**
     * Sync step 2 for a client: what a peer with `stateVector` has not seen.
     *
     * @returns {Uint8Array | null} null when the state vector is malformed
     */
    encodeMissingUpdate(session, stateVector) {
      try {
        Y.decodeStateVector(stateVector);
      } catch {
        return null;
      }
      return Y.encodeStateAsUpdate(session.ydoc, stateVector);
    },

    /** Sync step 1: compact summary (client id → clock) of what we have. */
    encodeSessionStateVector(session) {
      return Y.encodeStateVector(session.ydoc);
    },

    /** Save every dirty session now (graceful shutdown). */
    async flushAllSessions() {
      // Several passes: a save requested mid-flight is queued, not awaited.
      for (let pass = 0; pass < 3; pass += 1) {
        const pending = [...sessions.values()].filter((s) => s.dirty || s.saving);
        if (pending.length === 0) return;
        await Promise.allSettled(pending.map((session) => save(session)));
      }
    },

    /** @returns {number} documents currently held in memory */
    getSessionCount() {
      return sessions.size;
    },
  };

  return api;
}
