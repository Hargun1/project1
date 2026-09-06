/**
 * Health/readiness contracts.
 *
 * `/healthz` answers "is this process alive?" and touches nothing external, so a
 * load balancer never removes an instance because a dependency blipped.
 * `/readyz` answers "can this instance actually serve traffic?" and therefore
 * checks its dependencies.
 */

/** `not_configured` is used for a dependency this build does not wire up yet. */
export type DependencyState = 'up' | 'down' | 'not_configured';

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
  /** ISO-8601 */
  timestamp: string;
}

export interface ReadyResponse {
  status: 'ready' | 'degraded';
  checks: {
    database: DependencyState;
    redis: DependencyState;
  };
  /** ISO-8601 */
  timestamp: string;
}
