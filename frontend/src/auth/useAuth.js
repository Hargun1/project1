import { useContext } from 'react';
import { AuthContext } from './AuthContext.js';

/**
 * Consume the auth context.
 *
 * @returns {import('./AuthContext.js').AuthContextValue}
 * @throws if used outside an `<AuthProvider>`
 */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used inside an <AuthProvider>');
  }
  return ctx;
}
