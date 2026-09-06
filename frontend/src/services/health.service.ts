import type { HealthResponse, ReadyResponse } from '@collab/shared';
import { apiFetch } from './api';

export function getHealth(): Promise<HealthResponse> {
  return apiFetch<HealthResponse>('/healthz');
}

export function getReadiness(): Promise<ReadyResponse> {
  // A degraded instance still answers with a typed body, just with status 503.
  return apiFetch<ReadyResponse>('/readyz', { allowStatuses: [503] });
}
