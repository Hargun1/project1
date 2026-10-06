import { z } from 'zod';

/**
 * Zod schemas for incoming WebSocket messages (§12, §17).
 *
 * Every message read off the socket is validated before any handler touches it.
 * TypeScript types vanish at runtime; Zod is what actually prevents a malformed
 * payload from reaching business logic.
 *
 * The discriminated union mirrors the `WS_CLIENT_MESSAGE_TYPES` list in
 * `@collab/shared`. When Phase 6 adds `sync` and `awareness` payloads, they
 * are added as new branches here.
 */

const pingSchema = z.object({
  type: z.literal('ping'),
});

/**
 * Phase 6 placeholder — Yjs sync update.
 * `data` will carry a base64-encoded Uint8Array.
 */
const syncSchema = z.object({
  type: z.literal('sync'),
  documentId: z.string().uuid(),
  data: z.string().min(1),
});

/**
 * Phase 6 placeholder — Yjs awareness update.
 * `data` will carry a base64-encoded Uint8Array.
 */
const awarenessSchema = z.object({
  type: z.literal('awareness'),
  documentId: z.string().uuid(),
  data: z.string().min(1),
});

/**
 * The full client → server message union.
 *
 * `z.discriminatedUnion` checks the `type` field first and then applies only
 * the matching branch, giving clear error messages on mismatches.
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  pingSchema,
  syncSchema,
  awarenessSchema,
]);

/**
 * Attempt to parse raw text from a WebSocket frame into a validated message.
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
