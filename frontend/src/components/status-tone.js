import { isDependencyState } from '@collab/shared';

/**
 * The pill vocabulary lives in its own module rather than next to the component
 * so `StatusPill.jsx` exports a component and nothing else — that is what keeps
 * Vite's fast refresh working for the file (`react-refresh/only-export-components`).
 */

/** @type {readonly string[]} */
export const PILL_TONES = ['ok', 'warn', 'down', 'idle'];

/** Maps a backend dependency state from `/readyz` onto a pill tone. */
const DEPENDENCY_TONE = {
  up: 'ok',
  down: 'down',
  not_configured: 'idle',
};

/**
 * Resolves a `/readyz` dependency state to a pill tone.
 *
 * A bare `DEPENDENCY_TONE[state]` lookup used to be safe because the map was
 * typed as exhaustive over the state union — the compiler rejected a missing key.
 * Without that guarantee an unrecognised state (an older or newer backend adding
 * one) would yield `undefined`, and the pill would render with no colour classes
 * at all. `idle` is the honest fallback: unknown, not broken.
 *
 * @param {unknown} state value of `checks.<dependency>` from /readyz
 * @returns {string} one of PILL_TONES
 */
export function toneForDependency(state) {
  return isDependencyState(state) ? DEPENDENCY_TONE[state] : 'idle';
}
