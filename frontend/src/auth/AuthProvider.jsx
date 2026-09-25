import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthContext } from './AuthContext.js';
import * as authApi from '../services/auth.service.js';

/**
 * Provides auth state to the component tree.
 *
 * The **access token** is held in memory (a ref, not localStorage) because:
 * - It's short-lived (15 min).
 * - It's never persisted across page reloads — a silent `/refresh` on mount
 *   rehydrates it from the HttpOnly cookie the server manages.
 * - Keeping it out of storage mitigates XSS token theft.
 *
 * @param {{ children: import('react').ReactNode }} props
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const accessTokenRef = useRef(null);

  // Attempt silent refresh on mount — if the user has a valid refresh cookie,
  // they get logged in automatically without seeing the login page.
  useEffect(() => {
    let cancelled = false;

    async function tryRehydrate() {
      try {
        const refreshResult = await authApi.refreshToken();
        if (cancelled) return;
        accessTokenRef.current = refreshResult.accessToken;

        const meResult = await authApi.getMe(refreshResult.accessToken);
        if (cancelled) return;
        setUser(meResult.user);
      } catch {
        // No valid refresh cookie — user needs to log in.
        accessTokenRef.current = null;
        setUser(null);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    tryRehydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (data) => {
    const result = await authApi.login(data);
    accessTokenRef.current = result.accessToken;
    setUser(result.user);
  }, []);

  const register = useCallback(async (data) => {
    const result = await authApi.register(data);
    accessTokenRef.current = result.accessToken;
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      accessTokenRef.current = null;
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      get accessToken() {
        return accessTokenRef.current;
      },
      isAuthenticated: user !== null,
      isLoading,
      login,
      register,
      logout,
    }),
    [user, isLoading, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
