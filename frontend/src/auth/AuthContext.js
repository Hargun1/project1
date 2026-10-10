import { createContext } from 'react';

/**
 * @typedef {{
 *   user: object | null,
 *   accessToken: string | null,
 *   getAccessToken: () => Promise<string>,
 *   isAuthenticated: boolean,
 *   isLoading: boolean,
 *   login: (data: { email: string, password: string }) => Promise<void>,
 *   register: (data: { name: string, email: string, password: string }) => Promise<void>,
 *   logout: () => Promise<void>,
 * }} AuthContextValue
 */

export const AuthContext = createContext(/** @type {AuthContextValue | null} */ (null));
