import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AuthContext } from './AuthContext.js';
import { secondsUntilExpiry } from './jwt.js';
import * as authApi from '../services/auth.service.js';

/** Refresh when the access token has less than this left, not after it fails. */
const REFRESH_MARGIN_SECONDS = 60;

/**
 * Provides auth state to the component tree.
 *
 * The **access token** is held in memory (a ref, not localStorage) because:
 * - It's short-lived (15 min).
 * - It's never persisted across page reloads — a silent `/refresh` on mount
 *   rehydrates it from the HttpOnly cookie the server manages.
 * - Keeping it out of storage mitigates XSS token theft.
 *
 * Callers get it through `getAccessToken()`, which refreshes first when the
 * token is about to expire. That matters for long-lived pages: the editor can
 * stay open for hours, and every WebSocket reconnect needs a valid token to
 * mint a fresh ticket.
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

  /**
   * A token valid for at least REFRESH_MARGIN_SECONDS. If the refresh session
   * has been revoked or has expired, the user is signed out (and the route
   * guards redirect to /login) rather than left with a page that fails silently.
   */
  const getAccessToken = useCallback(async () => {
    const current = accessTokenRef.current;
    if (current && secondsUntilExpiry(current) > REFRESH_MARGIN_SECONDS) {
      return current;
    }
    try {
      const { accessToken } = await authApi.refreshToken();
      accessTokenRef.current = accessToken;
      return accessToken;
    } catch (error) {
      accessTokenRef.current = null;
      setUser(null);
      throw error;
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      get accessToken() {
        return accessTokenRef.current;
      },
      getAccessToken,
      isAuthenticated: user !== null,
      isLoading,
      login,
      register,
      logout,
    }),
    [user, isLoading, getAccessToken, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
