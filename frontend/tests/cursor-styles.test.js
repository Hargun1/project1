import { describe, expect, it } from 'vitest';
import { buildCursorCss, escapeCssString } from '../src/collaboration/cursor-styles.js';

describe('escapeCssString', () => {
  it('leaves plain names readable', () => {
    expect(escapeCssString('Hargun Madan 2')).toBe('Hargun Madan 2');
  });

  it('escapes every character that could end the string or the rule', () => {
    const escaped = escapeCssString('"}body{display:none}\\\n');
    expect(escaped).not.toMatch(/["{}\n]/);
    expect(escaped).toBe('\\22 \\7d body\\7b display\\3a none\\7d \\5c \\a ');
  });

  it('escapes non-ASCII as code points', () => {
    expect(escapeCssString('é😀')).toBe('\\e9 \\1f600 ');
  });
});

describe('buildCursorCss', () => {
  it('produces rules scoped to the client id', () => {
    const css = buildCursorCss([{ clientID: 42, color: '#22c55e', name: 'Rahul' }]);
    expect(css).toContain('.yRemoteSelection-42 { background-color: #22c55e40; }');
    expect(css).toContain('.yRemoteSelectionHead-42::after { content: "Rahul";');
  });

  it('cannot be broken out of by a hostile name', () => {
    const css = buildCursorCss([{ clientID: 1, color: '#22c55e', name: '"}body{display:none' }]);
    // Exactly the three rules we generate: no extra blocks were injected.
    expect(css.match(/\{/g)).toHaveLength(3);
    expect(css).not.toContain('body{');
  });

  it('replaces an invalid colour and skips an invalid client id', () => {
    const css = buildCursorCss([
      { clientID: 7, color: 'red;}*{color:red', name: 'x' },
      { clientID: '1 } * {', color: '#ffffff', name: 'y' },
    ]);
    expect(css).toContain('#a1a1aa');
    expect(css).not.toContain('red;');
    expect(css).not.toContain('y"');
  });
});
