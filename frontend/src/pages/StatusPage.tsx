import { useCallback, useEffect, useState } from 'react';
import type { HealthResponse, ReadyResponse } from '@collab/shared';
import { StatusPill } from '../components/StatusPill';
import { DEPENDENCY_TONE, type PillTone } from '../components/status-tone';
import { ApiError } from '../services/api';
import { getHealth, getReadiness } from '../services/health.service';

/**
 * Phase 1's real page: it proves the whole vertical slice works — a typed
 * request leaves the browser, Nginx/Vite proxies it, Express answers, and the
 * response is rendered against a type imported from `@collab/shared`.
 */

type Probe<T> =
  | { state: 'loading' }
  | { state: 'ok'; data: T }
  | { state: 'error'; message: string; requestId?: string };

const PHASES = [
  { number: 1, name: 'Foundation', done: true },
  { number: 2, name: 'Authentication', done: false },
  { number: 3, name: 'Documents', done: false },
  { number: 4, name: 'Monaco editor', done: false },
  { number: 5, name: 'WebSockets', done: false },
  { number: 6, name: 'Yjs collaboration', done: false },
  { number: 7, name: 'Presence', done: false },
  { number: 8, name: 'Redis Pub/Sub', done: false },
  { number: 9, name: 'Persistence + revisions', done: false },
  { number: 10, name: 'Role-based access', done: false },
  { number: 11, name: 'Security hardening', done: false },
  { number: 12, name: 'Docker + Nginx', done: false },
  { number: 13, name: 'Testing', done: false },
  { number: 14, name: 'AWS + scaling', done: false },
  { number: 15, name: 'Polish + docs', done: false },
] as const;

function toProbe<T>(result: PromiseSettledResult<T>): Probe<T> {
  if (result.status === 'fulfilled') {
    return { state: 'ok', data: result.value };
  }
  const reason: unknown = result.reason;
  if (reason instanceof ApiError) {
    return { state: 'error', message: reason.message, requestId: reason.requestId };
  }
  return { state: 'error', message: 'Unexpected error while checking the backend' };
}

interface StatusCardProps {
  title: string;
  tone: PillTone;
  pill: string;
  detail: string;
}

function StatusCard({ title, tone, pill, detail }: StatusCardProps) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-zinc-300">{title}</h3>
        <StatusPill tone={tone} label={pill} />
      </div>
      <p className="mt-2 font-mono text-xs leading-relaxed text-zinc-500">{detail}</p>
    </div>
  );
}

export function StatusPage() {
  const [health, setHealth] = useState<Probe<HealthResponse>>({ state: 'loading' });
  const [readiness, setReadiness] = useState<Probe<ReadyResponse>>({ state: 'loading' });
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    setHealth({ state: 'loading' });
    setReadiness({ state: 'loading' });

    const [healthResult, readinessResult] = await Promise.allSettled([getHealth(), getReadiness()]);

    setHealth(toProbe(healthResult));
    setReadiness(toProbe(readinessResult));
    setCheckedAt(new Date());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loading = health.state === 'loading' || readiness.state === 'loading';

  const apiCard: StatusCardProps =
    health.state === 'ok'
      ? {
          title: 'Backend API',
          tone: 'ok',
          pill: 'live',
          detail: `${health.data.service} v${health.data.version} · up ${health.data.uptimeSeconds}s`,
        }
      : health.state === 'loading'
        ? { title: 'Backend API', tone: 'idle', pill: 'checking', detail: 'GET /healthz …' }
        : {
            title: 'Backend API',
            tone: 'down',
            pill: 'unreachable',
            detail: health.message,
          };

  const databaseCard: StatusCardProps =
    readiness.state === 'ok'
      ? {
          title: 'PostgreSQL',
          tone: DEPENDENCY_TONE[readiness.data.checks.database],
          pill: readiness.data.checks.database.replace('_', ' '),
          detail:
            readiness.data.checks.database === 'up'
              ? 'SELECT 1 round-trip succeeded'
              : 'Readiness check failed — run `npm run infra:up`, then `npm run db:migrate`',
        }
      : readiness.state === 'loading'
        ? { title: 'PostgreSQL', tone: 'idle', pill: 'checking', detail: 'GET /readyz …' }
        : { title: 'PostgreSQL', tone: 'down', pill: 'unknown', detail: readiness.message };

  const redisCard: StatusCardProps =
    readiness.state === 'ok'
      ? {
          title: 'Redis',
          tone: DEPENDENCY_TONE[readiness.data.checks.redis],
          pill: readiness.data.checks.redis.replace('_', ' '),
          detail: 'Pub/Sub, rate limits and WS tickets are wired up in Phase 8',
        }
      : { title: 'Redis', tone: 'idle', pill: 'not configured', detail: 'Arrives in Phase 8' };

  return (
    <div className="space-y-10">
      <section className="space-y-3">
        <p className="font-mono text-xs uppercase tracking-widest text-emerald-400/80">
          Foundation complete
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          Real-time collaborative code editor
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400">
          Monaco + Yjs CRDTs over authenticated WebSockets, fanned across backend instances with
          Redis Pub/Sub and persisted as binary Yjs snapshots in PostgreSQL. This page reads the
          backend&apos;s liveness and readiness endpoints through the shared type package.
        </p>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-medium text-zinc-200">System status</h2>
          <div className="flex items-center gap-3">
            {checkedAt !== null && (
              <span className="font-mono text-xs text-zinc-500">
                checked {checkedAt.toLocaleTimeString()}
              </span>
            )}
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-1.5 text-sm text-zinc-200 transition hover:border-zinc-600 hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? 'Checking…' : 'Refresh'}
            </button>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatusCard {...apiCard} />
          <StatusCard {...databaseCard} />
          <StatusCard {...redisCard} />
        </div>
      </section>

      <section className="space-y-4">
        <h2 className="text-lg font-medium text-zinc-200">Build phases</h2>
        <ol className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {PHASES.map((phase) => (
            <li key={phase.number} className="flex items-center gap-2.5 text-sm">
              <span
                className={`grid size-5 shrink-0 place-items-center rounded font-mono text-[10px] ${
                  phase.done
                    ? 'bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-500/30'
                    : 'bg-zinc-800/70 text-zinc-500 ring-1 ring-inset ring-zinc-700/60'
                }`}
              >
                {phase.done ? '✓' : phase.number}
              </span>
              <span className={phase.done ? 'text-zinc-200' : 'text-zinc-500'}>{phase.name}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
