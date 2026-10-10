import { describe, expect, it } from 'vitest';
import { formatRelative } from '../src/utils/time.js';

const now = new Date('2026-10-09T12:00:00Z');
const ago = (seconds) => new Date(now.getTime() - seconds * 1000).toISOString();

describe('formatRelative', () => {
  it.each([
    [10, 'just now'],
    [120, '2 minutes ago'],
    [3 * 3600, '3 hours ago'],
    [24 * 3600, 'yesterday'],
    [14 * 24 * 3600, '2 weeks ago'],
  ])('%i seconds ago → %s', (seconds, expected) => {
    expect(formatRelative(ago(seconds), now)).toBe(expected);
  });

  it('does not throw on garbage', () => {
    expect(formatRelative('not a date', now)).toBe('unknown time');
  });
});
