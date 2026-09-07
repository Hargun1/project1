import { apiFetch } from './api.js';

/**
 * Liveness. Resolves to `{ status, service, version, uptimeSeconds, timestamp }`
 * — see `shared/src/health.js` for the documented shape.
 *
 * @returns {Promise<unknown>}
 */
export function getHealth() {
  return apiFetch('/healthz');
}

/**
 * Readiness. Resolves to `{ status, checks: { database, redis }, timestamp }`.
 *
 * A degraded instance still answers with a valid body, just with status 503, so
 * 503 is allowed through rather than thrown.
 *
 * @returns {Promise<unknown>}
 */
export function getReadiness() {
  return apiFetch('/readyz', { allowStatuses: [503] });
}
