import { useCallback, useMemo, useReducer, useRef } from 'react';
import { ToastContext, toastReducer, TOAST_DURATION_MS } from './toast-context.js';

const STYLE = {
  success: 'border-emerald-500/30 bg-emerald-950/90 text-emerald-100',
  info: 'border-zinc-600 bg-zinc-900/95 text-zinc-100',
  error: 'border-red-500/30 bg-red-950/90 text-red-100',
};

const ICON = { success: '✓', info: 'i', error: '!' };

/**
 * Renders toasts bottom-right. The region is an ARIA live region, so screen
 * readers announce each toast: politely for confirmations, assertively for
 * errors.
 *
 * @param {{ children: import('react').ReactNode }} props
 */
export function ToastProvider({ children }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => dispatch({ type: 'dismiss', id }), []);

  const show = useCallback(
    (kind, message) => {
      const id = nextId.current;
      nextId.current += 1;
      dispatch({ type: 'add', toast: { id, kind, message } });
      setTimeout(() => dismiss(id), TOAST_DURATION_MS[kind]);
    },
    [dismiss],
  );

  const api = useMemo(
    () => ({
      success: (message) => show('success', message),
      info: (message) => show('info', message),
      error: (message) => show('error', message),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:left-auto sm:w-96"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.kind === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex w-full items-start gap-3 rounded-lg border px-4 py-3 text-sm shadow-lg shadow-black/40 ${STYLE[toast.kind]}`}
          >
            <span
              aria-hidden="true"
              className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-white/10 text-xs font-bold"
            >
              {ICON[toast.kind]}
            </span>
            <p className="flex-1">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
              className="-mr-1 rounded px-1 text-current opacity-60 transition hover:opacity-100"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
