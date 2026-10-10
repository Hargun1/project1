/**
 * Presence contracts (Phase 7).
 *
 * Presence travels as Yjs *awareness* state, which is ephemeral by design: it is
 * never written to PostgreSQL, and a client that stops renewing it disappears
 * from everyone's view after 30 s (y-protocols' `outdatedTimeout`).
 *
 * Each client's awareness state has exactly this shape (validated by the server
 * with Zod; anything else is refused):
 *
 *   {
 *     user: { id, name, color }           id/name must match the authenticated socket
 *     selection?: { anchor, head } | null Y.RelativePosition JSON, set by y-monaco
 *   }
 */

/**
 * Cursor colours chosen to stay readable on Monaco's dark theme. Eight is
 * enough that collaborators rarely collide; a collision is cosmetic.
 */
export const PRESENCE_COLORS = [
  '#f97316', // orange
  '#22c55e', // green
  '#3b82f6', // blue
  '#e879f9', // fuchsia
  '#facc15', // yellow
  '#2dd4bf', // teal
  '#f43f5e', // rose
  '#a78bfa', // violet
];

/**
 * A stable colour per *user*, so the same person has the same colour in every
 * tab and every session without storing anything.
 *
 * @param {string} userId
 * @returns {string} a `#rrggbb` colour from PRESENCE_COLORS
 */
export function colorForUser(userId) {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length];
}
