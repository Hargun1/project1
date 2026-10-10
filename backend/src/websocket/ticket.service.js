import { randomBytes } from 'node:crypto';
import { redis } from '../redis/redis.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

/**
 * WebSocket connection tickets (§11).
 *
 * Browsers cannot attach custom headers to a WebSocket handshake, so a raw JWT
 * in the query string would leak into server access logs and browser history.
 * Instead the client calls an authenticated REST endpoint first, receives a
 * short-lived opaque ticket, and sends *that* as `?ticket=...` on the WS URL.
 *
 * Each ticket is:
 *   - stored in Redis with a TTL of `WS_TICKET_TTL_SECONDS`
 *   - cryptographically random (32 bytes, hex-encoded → 64 chars)
 *   - scoped to one (userId, documentId) pair
 *   - single-use: the first `consume()` call deletes it
 */

const TICKET_PREFIX = 'ws_ticket:';

/**
 * Issue a new WebSocket connection ticket.
 *
 * @param {string} userId     authenticated user
 * @param {string} documentId document the ticket grants access to
 * @returns {Promise<string>}  the opaque ticket string
 */
export async function issueTicket(userId, documentId) {
  const ticket = randomBytes(32).toString('hex');
  const key = `${TICKET_PREFIX}${ticket}`;
  const payload = JSON.stringify({ userId, documentId });

  await redis.set(key, payload, 'EX', env.WS_TICKET_TTL_SECONDS);

  logger.debug({ userId, documentId, ttl: env.WS_TICKET_TTL_SECONDS }, 'ws ticket issued');

  return ticket;
}

/**
 * Consume (validate + delete) a ticket in one atomic step.
 *
 * `GETDEL` is atomic: if two WebSocket handshakes race with the same ticket,
 * exactly one gets the payload and the other gets `null`.
 *
 * @param {string} ticket
 * @returns {Promise<{ userId: string, documentId: string } | null>}
 */
export async function consumeTicket(ticket) {
  if (typeof ticket !== 'string' || ticket.length === 0) {
    return null;
  }

  const key = `${TICKET_PREFIX}${ticket}`;

  // GETDEL: get the value and delete the key in one round-trip.
  // Available since Redis 6.2. Falls back to GET + DEL if unavailable.
  let raw;
  try {
    raw = await redis.getdel(key);
  } catch {
    // Fallback for older Redis versions without GETDEL
    raw = await redis.get(key);
    if (raw !== null) {
      await redis.del(key);
    }
  }

  if (raw === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.userId === 'string' &&
      typeof parsed.documentId === 'string'
    ) {
      return { userId: parsed.userId, documentId: parsed.documentId };
    }
    logger.warn({ ticket: ticket.slice(0, 8) + '…' }, 'ws ticket payload malformed');
    return null;
  } catch {
    logger.warn({ ticket: ticket.slice(0, 8) + '…' }, 'ws ticket payload not valid JSON');
    return null;
  }
}
