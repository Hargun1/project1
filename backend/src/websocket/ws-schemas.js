import { z } from 'zod';
import { isBase64 } from '@collab/shared';
import { WS_MAX_PAYLOAD_BYTES } from '../config/constants.js';

/**
 * Zod schemas for inbound WebSocket messages (§12, §17).
 *
 * Every message read off the socket is validated here before any handler
 * touches it. The union mirrors `WS_CLIENT_MESSAGE_TYPES` in `@collab/shared`.
 *
 * Base64 is checked for *shape* only; whether the bytes are a valid Yjs update
 * is decided by the collaboration service, which decodes before applying.
 */

const base64 = z
  .string()
  // Base64 is 4/3 the size of its bytes; the frame limit already bounds this,
  // but an explicit cap keeps the schema self-describing.
  .max(Math.ceil((WS_MAX_PAYLOAD_BYTES * 4) / 3))
  .refine(isBase64, 'must be a base64 string');

const pingSchema = z.object({ type: z.literal('ping') });

const syncStep1Schema = z.object({
  type: z.literal('sync-step1'),
  stateVector: base64.pipe(z.string().min(1)),
});

/** May legitimately be the 2-byte empty update when the client has nothing new. */
const syncStep2Schema = z.object({
  type: z.literal('sync-step2'),
  update: base64.pipe(z.string().min(1)),
});

const updateSchema = z.object({
  type: z.literal('update'),
  update: base64.pipe(z.string().min(1)),
});

/** A y-protocols awareness update; its JSON content is validated by presence.service. */
const awarenessSchema = z.object({
  type: z.literal('awareness'),
  update: base64.pipe(z.string().min(1)),
});

/**
 * `z.discriminatedUnion` reads `type` first and validates only the matching
 * branch, so errors name the real problem instead of listing every branch.
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  pingSchema,
  syncStep1Schema,
  syncStep2Schema,
  updateSchema,
  awarenessSchema,
]);

/**
 * Parse raw text from a WebSocket frame into a validated message.
 *
 * @param {string} raw
 * @returns {{ ok: true, message: object } | { ok: false, error: string }}
 */
export function parseClientMessage(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Message is not valid JSON' };
  }

  const result = clientMessageSchema.safeParse(json);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `Invalid message: ${issue?.path?.join('.') || 'root'} — ${issue?.message || 'unknown'}`,
    };
  }

  return { ok: true, message: result.data };
}
