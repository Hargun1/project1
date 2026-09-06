import type { DependencyState } from '@collab/shared';

/**
 * The pill vocabulary lives in its own module rather than next to the component
 * so `StatusPill.tsx` exports a component and nothing else — that is what keeps
 * Vite's fast refresh working for the file (`react-refresh/only-export-components`).
 */
export type PillTone = 'ok' | 'warn' | 'down' | 'idle';

/** Maps a backend dependency state from `/readyz` onto a pill tone. */
export const DEPENDENCY_TONE: Record<DependencyState, PillTone> = {
  up: 'ok',
  down: 'down',
  not_configured: 'idle',
};
