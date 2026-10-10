import { isRole } from './roles.js';

/**
 * The permission matrix (§16), defined once for both sides.
 *
 * The backend calls `can()` to *enforce*; the frontend calls the same function
 * only to decide which buttons to show. Hiding a button is a courtesy — every
 * decision is re-made on the server.
 *
 * Without a type checker, a typo in an action name would silently be "not
 * allowed". `can()` therefore throws on an unknown action, so the mistake fails
 * loudly the first time that code path runs (and in tests).
 */
export const ACTIONS = [
  'document:read', //      open, see content, browse history, see members
  'document:edit', //      change content over the WebSocket
  'document:rename', //    rename, change language
  'document:delete', //    soft delete
  'members:manage', //     invite, change roles, remove others
  'revision:create', //    "Save version"
  'revision:restore', //   restore an older revision
];

export const PERMISSIONS = {
  OWNER: [
    'document:read',
    'document:edit',
    'document:rename',
    'document:delete',
    'members:manage',
    'revision:create',
    'revision:restore',
  ],
  EDITOR: ['document:read', 'document:edit', 'revision:create'],
  VIEWER: ['document:read'],
};

/**
 * Roles an OWNER may hand out through member management. OWNER is not one of
 * them: every document has exactly one owner (ownership transfer is a future
 * extension, not a side effect of "change role").
 */
export const ASSIGNABLE_ROLES = ['EDITOR', 'VIEWER'];

/**
 * @param {unknown} role    a member's role, or null/undefined for "not a member"
 * @param {string} action   one of ACTIONS
 * @returns {boolean}
 * @throws {TypeError} when `action` is not a known action
 */
export function can(role, action) {
  if (!ACTIONS.includes(action)) {
    throw new TypeError(`Unknown permission action: ${String(action)}`);
  }
  return isRole(role) && PERMISSIONS[role].includes(action);
}
