import { z } from 'zod';
import { isBase64 } from '@collab/shared';
import { WS_MAX_PAYLOAD_BYTES } from '../config/constants.js';

/**
 * Messages exchanged *between backend instances* over Redis Pub/Sub (Phase 8).
 *
 * Wire format — a deliberate simplicity trade-off (§19): a JSON envelope with
 * the binary Yjs payload base64-encoded, exactly like the WebSocket protocol.
 * Raw binary Pub/Sub would save ~25% of bytes but needs a binary-safe client
 * path and a second message format to validate and debug. Here one envelope
 * shape covers both hops, and `redis-cli SUBSCRIBE document:<id>` shows readable
 * traffic during a demo.
 *
 *   { v: 1, from: <instanceId>, to: <instanceId> | null, type, data: <base64> }
 *
 *   update      a live Yjs update made by a client of `from`
 *   awareness   presence changes on `from`
 *   sync-step1  `from`'s state vector. With `to: null` it is a hello ("I just
 *               (re)subscribed — send me what I missed"); every peer answers
 *               with sync-step2 *and* its own targeted step 1.
 *   sync-step2  the update the recipient is missing
 *
 * Redis sits inside the trust boundary, but a malformed message from an older
 * or buggy instance must still not crash this one, so the envelope is validated.
 */

export const BUS_PROTOCOL_VERSION = 1;

const base64 = z
  .string()
  .max(Math.ceil((WS_MAX_PAYLOAD_BYTES * 4) / 3) * 4)
  .refine(isBase64, 'must be base64');

export const busMessageSchema = z.object({
  v: z.literal(BUS_PROTOCOL_VERSION),
  from: z.string().min(1).max(128),
  to: z.string().min(1).max(128).nullable(),
  type: z.enum(['update', 'awareness', 'sync-step1', 'sync-step2']),
  data: base64,
});

/**
 * @param {string} raw
 * @returns {z.infer<typeof busMessageSchema> | null}
 */
export function parseBusMessage(raw) {
  try {
    const result = busMessageSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** One channel per document (§22). */
export function documentChannel(documentId) {
  return `document:${documentId}`;
}

// ── Access changes (Phase 10) ───────────────────────────────────────────────

/**
 * One global channel: "someone's access to a document changed — re-check".
 *
 * The message deliberately carries no role. Each instance re-reads the truth
 * from PostgreSQL for its affected sockets, so a lost, duplicated or reordered
 * message can never grant access; at worst it delays a revocation until the
 * periodic re-check (ACCESS_RECHECK_INTERVAL_MS).
 *
 *   { v: 1, from: <instanceId>, documentId, userId: <uuid> | null }
 *   userId null = everyone on the document (e.g. it was deleted)
 */
export const ACCESS_CHANNEL = 'access-changes';

export const accessMessageSchema = z.object({
  v: z.literal(BUS_PROTOCOL_VERSION),
  from: z.string().min(1).max(128),
  documentId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
});

/** @returns {z.infer<typeof accessMessageSchema> | null} */
export function parseAccessMessage(raw) {
  try {
    const result = accessMessageSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
