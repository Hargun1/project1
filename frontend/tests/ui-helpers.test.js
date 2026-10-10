import { describe, expect, it } from 'vitest';
import { languageFromFileName, languageLabel } from '../src/utils/languages.js';
import { roleLabel } from '../src/utils/roles.js';
import { MAX_TOASTS, toastReducer } from '../src/toast/toast-context.js';

/** Phase 15 helpers behind the dashboard, editor and toasts. */

describe('languageFromFileName', () => {
  it.each([
    ['main.py', 'python'],
    ['server.js', 'javascript'],
    ['App.tsx', 'typescript'],
    ['Main.JAVA', 'java'],
    ['vector.hpp', 'cpp'],
    ['index.htm', 'html'],
    ['styles.css', 'css'],
    [' package.json ', 'json'],
  ])('%s → %s', (name, language) => {
    expect(languageFromFileName(name)).toBe(language);
  });

  it('returns null without a known extension, so the chosen language stays', () => {
    expect(languageFromFileName('notes.md')).toBeNull();
    expect(languageFromFileName('Makefile')).toBeNull();
    expect(languageFromFileName('archive.')).toBeNull();
  });
});

describe('labels', () => {
  it('shows languages and roles as words, not identifiers', () => {
    expect(languageLabel('cpp')).toBe('C++');
    expect(languageLabel('javascript')).toBe('JavaScript');
    expect(languageLabel('cobol')).toBe('cobol');
    expect(roleLabel('OWNER')).toBe('Owner');
    expect(roleLabel('VIEWER')).toBe('Viewer');
    expect(roleLabel(undefined)).toBe('');
  });
});

describe('toastReducer', () => {
  const toast = (id) => ({ id, kind: 'success', message: `t${id}` });

  it('adds toasts and dismisses one by id', () => {
    let state = toastReducer([], { type: 'add', toast: toast(1) });
    state = toastReducer(state, { type: 'add', toast: toast(2) });
    expect(toastReducer(state, { type: 'dismiss', id: 1 }).map((t) => t.id)).toEqual([2]);
  });

  it(`keeps at most ${MAX_TOASTS}, dropping the oldest`, () => {
    let state = [];
    for (let id = 1; id <= MAX_TOASTS + 2; id += 1) {
      state = toastReducer(state, { type: 'add', toast: toast(id) });
    }
    expect(state.map((t) => t.id)).toEqual([3, 4, 5]);
  });

  it('ignores a dismiss for a toast that is already gone (its timer fired late)', () => {
    const state = [toast(1)];
    expect(toastReducer(state, { type: 'dismiss', id: 9 })).toEqual(state);
  });
});
