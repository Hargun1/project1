import { createContext, useContext } from 'react';

/**
 * Toasts (Phase 15): short, self-dismissing confirmations and errors for
 * actions whose result is not otherwise visible ("Document deleted", "Saved as
 * revision 3", "Invite failed"). Persistent problems stay on the page instead.
 */
export const ToastContext = createContext(null);

/** How long a toast stays, in milliseconds. Errors stay longer. */
export const TOAST_DURATION_MS = { success: 4000, info: 4000, error: 7000 };

/** At most this many toasts at once; the oldest goes first. */
export const MAX_TOASTS = 3;

/**
 * Pure state transitions, so they can be unit-tested without React.
 *
 * @param {{ id: number, kind: string, message: string }[]} toasts
 * @param {{ type: 'add', toast: object } | { type: 'dismiss', id: number }} action
 */
export function toastReducer(toasts, action) {
  switch (action.type) {
    case 'add':
      return [...toasts, action.toast].slice(-MAX_TOASTS);
    case 'dismiss':
      return toasts.filter((toast) => toast.id !== action.id);
    default:
      return toasts;
  }
}

/**
 * @returns {{ success: (message: string) => void, error: (message: string) => void, info: (message: string) => void }}
 */
export function useToast() {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast() must be used inside <ToastProvider>');
  return value;
}
