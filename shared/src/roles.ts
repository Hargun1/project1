/**
 * Document roles.
 *
 * Modelled as a union derived from a `const` tuple rather than a bare `string`,
 * so a typo in a permission check is a compile error instead of a silent
 * authorization hole. The same union backs the Prisma enum and every REST/WS
 * payload, on both sides of the wire.
 */
export const ROLES = ['OWNER', 'EDITOR', 'VIEWER'] as const;

export type Role = (typeof ROLES)[number];

/** Runtime guard for values arriving from outside the process. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}
