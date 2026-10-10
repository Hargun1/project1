/**
 * Reads the `exp` claim of a JWT *without verifying it*.
 *
 * The browser cannot verify a signature (it does not have the secret) and does
 * not need to: the server verifies every request. This is only a scheduling
 * hint — "refresh before this token stops working" — so a tampered value can at
 * worst cause one unnecessary refresh or one 401.
 *
 * @param {string} token
 * @returns {number} seconds until expiry; 0 when unreadable or already expired
 */
export function secondsUntilExpiry(token) {
  try {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return typeof exp === 'number' ? Math.max(0, exp - Date.now() / 1000) : 0;
  } catch {
    return 0;
  }
}
