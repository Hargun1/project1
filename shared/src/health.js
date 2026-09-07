/**
 * Health/readiness contracts.
 *
 * `/healthz` answers "is this process alive?" and touches nothing external, so a
 * load balancer never removes an instance because a dependency blipped.
 * `/readyz` answers "can this instance actually serve traffic?" and therefore
 * checks its dependencies.
 *
 * The response shapes are documented rather than declared:
 *
 *   GET /healthz -> 200
 *     { status: 'ok', service, version, uptimeSeconds, timestamp }
 *
 *   GET /readyz  -> 200 when ready, 503 when degraded (body is valid either way)
 *     { status: 'ready' | 'degraded',
 *       checks: { database: DependencyState, redis: DependencyState },
 *       timestamp }
 *
 * `timestamp` is always ISO-8601.
 */

/**
 * The states a dependency can report.
 *
 * `not_configured` is an honest signal for a dependency this build does not wire
 * up yet — distinct from `down`, which means "configured and unreachable".
 */
export const DEPENDENCY_STATES = ['up', 'down', 'not_configured'];

/**
 * Runtime guard for a dependency state read off a `/readyz` body.
 *
 * @param {unknown} value
 * @returns {boolean} true when `value` is one of `DEPENDENCY_STATES`
 */
export function isDependencyState(value) {
  return typeof value === 'string' && DEPENDENCY_STATES.includes(value);
}
