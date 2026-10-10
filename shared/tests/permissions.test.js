import { describe, expect, it } from 'vitest';
import { ACTIONS, ASSIGNABLE_ROLES, can, PERMISSIONS, ROLES } from '../src/index.js';

describe('permission matrix (§16)', () => {
  it.each([
    ['OWNER', ACTIONS],
    ['EDITOR', ['document:read', 'document:edit', 'revision:create']],
    ['VIEWER', ['document:read']],
  ])('%s may do exactly %j', (role, allowed) => {
    for (const action of ACTIONS) {
      expect(can(role, action)).toBe(allowed.includes(action));
    }
  });

  it('gives a non-member nothing', () => {
    for (const action of ACTIONS) {
      expect(can(null, action)).toBe(false);
      expect(can(undefined, action)).toBe(false);
      expect(can('ADMIN', action)).toBe(false);
    }
  });

  it('throws on an unknown action instead of silently denying', () => {
    expect(() => can('OWNER', 'document:destroy')).toThrow(TypeError);
  });

  it('covers every role and never lets members hand out OWNER', () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual([...ROLES].sort());
    expect(ASSIGNABLE_ROLES).not.toContain('OWNER');
  });
});
