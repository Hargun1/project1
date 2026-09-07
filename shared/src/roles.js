/**
 * Document roles.
 *
 * `ROLES` is the single source of truth: the Prisma enum mirrors it, and every
 * REST/WS payload on both sides of the wire is checked against it.
 *
 * In plain JavaScript a typo in a permission check cannot be caught at compile
 * time, so `isRole()` is not a convenience — it is the only thing standing
 * between a bad role string and an authorization decision. Validate at every
 * trust boundary; never compare against a bare string literal inline.
 */
export const ROLES = ['OWNER', 'EDITOR', 'VIEWER'];

/**
 * Runtime guard for values arriving from outside the process.
 *
 * @param {unknown} value
 * @returns {boolean} true when `value` is one of `ROLES`
 */
export function isRole(value) {
  return typeof value === 'string' && ROLES.includes(value);
}
