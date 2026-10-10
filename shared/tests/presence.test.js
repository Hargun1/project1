import { describe, expect, it } from 'vitest';
import { colorForUser, PRESENCE_COLORS } from '../src/index.js';

describe('colorForUser', () => {
  it('is stable for a user, so every tab and session shows the same colour', () => {
    const id = '3f2b8c1e-0d4a-4e6b-9a51-7c2d9e0f1a2b';
    expect(colorForUser(id)).toBe(colorForUser(id));
  });

  it('always returns a palette colour in #rrggbb form', () => {
    for (let i = 0; i < 50; i += 1) {
      const color = colorForUser(`user-${i}`);
      expect(PRESENCE_COLORS).toContain(color);
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('spreads different users across the palette', () => {
    const used = new Set(Array.from({ length: 50 }, (_, i) => colorForUser(`user-${i}`)));
    expect(used.size).toBeGreaterThan(PRESENCE_COLORS.length / 2);
  });
});
