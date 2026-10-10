import { z } from 'zod';
import * as decoding from 'lib0/decoding';
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';

/**
 * Presence (§20): who is in a document and where their cursor is.
 *
 * Awareness state is ephemeral and never persisted. The server keeps one
 * `Awareness` per open document anyway, for three reasons:
 *
 *   1. A client joining late needs everyone's *current* presence immediately,
 *      not whenever each of them next moves their cursor.
 *   2. When a socket drops, the server knows which awareness entries that
 *      connection owned and removes them at once, instead of everyone waiting
 *      30 s for the entry to time out.
 *   3. Awareness state is client-written JSON that ends up rendered in other
 *      people's browsers. It is validated here, and its identity is checked
 *      against the authenticated socket, so nobody can label their cursor with
 *      someone else's name or remove someone else's cursor.
 */

/** A connection normally controls one awareness client id (its Y.Doc's). */
const MAX_CLIENT_IDS_PER_CONNECTION = 3;

const yjsIdSchema = z
  .object({ client: z.number().int().nonnegative(), clock: z.number().int().nonnegative() })
  .strict();

/** JSON form of a `Y.RelativePosition`, exactly as y-monaco writes it. */
const relativePositionSchema = z
  .object({
    type: yjsIdSchema.nullable().optional(),
    tname: z.string().max(64).nullable().optional(),
    item: yjsIdSchema.nullable().optional(),
    assoc: z.number().int().optional(),
  })
  .strict();

export const awarenessStateSchema = z
  .object({
    user: z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1).max(100),
        color: z.string().regex(/^#[0-9a-f]{6}$/i),
      })
      .strict(),
    selection: z
      .object({ anchor: relativePositionSchema, head: relativePositionSchema })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

/**
 * Decode an awareness update without applying it.
 *
 * Wire format (y-protocols): varuint count, then per entry varuint clientID,
 * varuint clock, varstring JSON state.
 *
 * @param {Uint8Array} update
 * @returns {{ clientID: number, clock: number, state: unknown }[]}
 * @throws on truncated input, trailing bytes, or invalid JSON
 */
export function decodeAwarenessUpdate(update) {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  if (count > MAX_CLIENT_IDS_PER_CONNECTION) {
    throw new RangeError('too many awareness entries');
  }
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const clientID = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const state = JSON.parse(decoding.readVarString(decoder));
    entries.push({ clientID, clock, state });
  }
  if (decoding.hasContent(decoder)) {
    throw new RangeError('trailing bytes after awareness update');
  }
  return entries;
}

/**
 * Per-document presence state. Created with the collaboration session.
 *
 * @param {import('yjs').Doc} ydoc
 */
export function createPresence(ydoc) {
  const awareness = new Awareness(ydoc);
  // The server is a relay, not a participant: it must not appear as a user.
  awareness.setLocalState(null);
  return {
    awareness,
    /**
     * awareness clientID → owner: a local connection, or `{ remote: true, userId }`
     * for an entry that belongs to a client of another backend instance.
     * @type {Map<number, object>}
     */
    owners: new Map(),
  };
}

/** Stop the awareness timeout interval and drop all state. */
export function destroyPresence(presence) {
  presence.awareness.destroy();
  presence.owners.clear();
}

/**
 * Validate and apply an awareness update sent by `conn`.
 *
 * @param {ReturnType<typeof createPresence>} presence
 * @param {{ userId: string, userName: string }} conn
 * @param {Uint8Array} update
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function applyClientAwareness(presence, conn, update) {
  let entries;
  try {
    entries = decodeAwarenessUpdate(update);
  } catch {
    return { ok: false, code: 'PROTOCOL_ERROR', message: 'Malformed awareness update' };
  }

  // Validate every entry before applying any of them: all or nothing.
  for (const { clientID, state } of entries) {
    if (state !== null) {
      const parsed = awarenessStateSchema.safeParse(state);
      if (!parsed.success) {
        return { ok: false, code: 'PROTOCOL_ERROR', message: 'Invalid awareness state' };
      }
      if (parsed.data.user.id !== conn.userId || parsed.data.user.name !== conn.userName) {
        return {
          ok: false,
          code: 'FORBIDDEN',
          message: 'Awareness identity must match the authenticated user',
        };
      }
    }

    const owner = presence.owners.get(clientID);
    // Another *user's* entry: never writable. The same user's entry from an old,
    // possibly half-open socket is taken over — that is a tab reconnecting.
    if (owner && owner !== conn && owner.userId !== conn.userId) {
      return {
        ok: false,
        code: 'FORBIDDEN',
        message: 'Awareness client id belongs to another user',
      };
    }
    if (!owner && ownedBy(presence, conn).length >= MAX_CLIENT_IDS_PER_CONNECTION) {
      return { ok: false, code: 'PROTOCOL_ERROR', message: 'Too many awareness client ids' };
    }
  }

  for (const { clientID } of entries) {
    presence.owners.set(clientID, conn);
  }
  applyAwarenessUpdate(presence.awareness, update, conn);
  return { ok: true };
}

/**
 * Apply presence relayed from another backend instance (Phase 8).
 *
 * That instance already validated the update against its own authenticated
 * socket. Here we only record who owns each entry, so that a client on *this*
 * instance cannot claim an entry belonging to a user connected elsewhere.
 *
 * @param {ReturnType<typeof createPresence>} presence
 * @param {Uint8Array} update
 * @param {unknown} origin  tag so the update is not published back to Redis
 * @returns {boolean} false when the update is malformed
 */
export function applyRemoteAwareness(presence, update, origin) {
  let entries;
  try {
    entries = decodeAwarenessUpdate(update);
  } catch {
    return false;
  }
  for (const { clientID, state } of entries) {
    if (state === null) {
      if (presence.owners.get(clientID)?.remote) presence.owners.delete(clientID);
    } else if (typeof state?.user?.id === 'string') {
      // Live state from elsewhere means the client now lives elsewhere — even if a
      // stale local socket (a tab that reconnected to another instance) still
      // claims it. Moving ownership stops that socket's eventual cleanup from
      // deleting the client's *current* cursor on every instance.
      presence.owners.set(clientID, { remote: true, userId: state.user.id });
    }
  }
  applyAwarenessUpdate(presence.awareness, update, origin);
  return true;
}

/**
 * Presence of the clients connected to *this* instance — what another instance
 * needs when it starts serving the same document.
 *
 * @returns {Uint8Array | null}
 */
export function encodeLocalAwareness(presence) {
  const states = presence.awareness.getStates();
  const local = [...presence.owners]
    .filter(([clientID, owner]) => !owner.remote && states.has(clientID))
    .map(([clientID]) => clientID);
  return local.length > 0 ? encodeAwarenessUpdate(presence.awareness, local) : null;
}

/**
 * Everyone's current presence, for a client that has just joined.
 *
 * @returns {Uint8Array | null} null when nobody has published presence yet
 */
export function encodeFullAwareness(presence) {
  const clients = [...presence.awareness.getStates().keys()];
  return clients.length > 0 ? encodeAwarenessUpdate(presence.awareness, clients) : null;
}

/**
 * A connection closed: remove the awareness entries it still owns, so other
 * clients drop its cursor immediately. Entries already taken over by a newer
 * connection of the same user are left alone.
 *
 * Removing a *remote* entry keeps its clock unchanged (y-protocols only bumps the
 * clock when a client removes itself), so when that client reconnects, its next
 * announcement is strictly newer and is accepted everywhere.
 *
 * Applied with origin `null`, so every remaining connection forwards it.
 */
export function releaseConnectionPresence(presence, conn) {
  const owned = ownedBy(presence, conn);
  for (const clientID of owned) {
    presence.owners.delete(clientID);
  }
  if (owned.length > 0) {
    removeAwarenessStates(presence.awareness, owned, null);
  }
}

function ownedBy(presence, conn) {
  return [...presence.owners].filter(([, owner]) => owner === conn).map(([clientID]) => clientID);
}
