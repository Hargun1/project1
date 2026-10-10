import { useCallback, useEffect, useState } from 'react';
import { StatusPill } from '../components/StatusPill.jsx';
import { toneForDependency } from '../components/status-tone.js';
import { ApiError } from '../services/api.js';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/useAuth.js';
import { getHealth, getReadiness } from '../services/health.service.js';

/**
 * The home page: what the app does, a way in, and live system status. The
 * status cards prove the whole vertical slice works — a request leaves the
 * browser, Vite (dev) or Nginx (prod) proxies it, Express answers, and Prisma
 * round-trips PostgreSQL to produce the readiness result.
 *
 * A probe is `{ state: 'loading' }`, `{ state: 'ok', data }`, or
 * `{ state: 'error', message, requestId? }`.
 */

const FEATURES = [
  {
    title: 'Real-time editing',
    text: 'Several people type in one file at once. Edits merge through a CRDT (Yjs), so there are no locks and no conflicts.',
  },
  {
    title: 'Live presence',
    text: 'See who is here, with named, coloured cursors and selections, on every connected instance.',
  },
  {
    title: 'Revision history',
    text: 'Versions are stored as binary CRDT snapshots; restoring one adds a new version and never rewrites history.',
  },
  {
    title: 'Sharing with roles',
    text: 'Owner, editor or viewer, enforced on the server for every request and every WebSocket message.',
  },
];

function toProbe(result) {
  if (result.status === 'fulfilled') {
    return { state: 'ok', data: result.value };
  }
  const reason = result.reason;
  if (reason instanceof ApiError) {
    return { state: 'error', message: reason.message, requestId: reason.requestId };
  }
  return { state: 'error', message: 'Unexpected error while checking the backend' };
}

/** Renders an unvalidated dependency state as a label without assuming its type. */
function dependencyLabel(state) {
  return typeof state === 'string' ? state.replace('_', ' ') : 'unknown';
}

function StatusCard({ title, tone, pill, detail }) {
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
  const { isAuthenticated } = useAuth();
  const [health, setHealth] = useState({ state: 'loading' });
  const [readiness, setReadiness] = useState({ state: 'loading' });
  const [checkedAt, setCheckedAt] = useState(null);

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

  // Optional chaining throughout: with no compile-time check that the body has
  // the documented shape, a malformed response must render as "unknown" rather
  // than crash the page on a missing property.
  const databaseState = readiness.data?.checks?.database;
  const redisState = readiness.data?.checks?.redis;

  const apiCard =
    health.state === 'ok'
      ? {
          title: 'Backend API',
          tone: 'ok',
          pill: 'live',
          detail: `${health.data?.service} v${health.data?.version} · up ${health.data?.uptimeSeconds}s`,
        }
      : health.state === 'loading'
        ? { title: 'Backend API', tone: 'idle', pill: 'checking', detail: 'GET /healthz …' }
        : {
            title: 'Backend API',
            tone: 'down',
            pill: 'unreachable',
            detail: health.message,
          };

  const databaseCard =
    readiness.state === 'ok'
      ? {
          title: 'PostgreSQL',
          tone: toneForDependency(databaseState),
          pill: dependencyLabel(databaseState),
          detail:
            databaseState === 'up'
              ? 'SELECT 1 round-trip succeeded'
              : 'Readiness check failed — run `npm run infra:up`, then `npm run db:migrate`',
        }
      : readiness.state === 'loading'
        ? { title: 'PostgreSQL', tone: 'idle', pill: 'checking', detail: 'GET /readyz …' }
        : { title: 'PostgreSQL', tone: 'down', pill: 'unknown', detail: readiness.message };

  const redisCard =
    readiness.state === 'ok'
      ? {
          title: 'Redis',
          tone: toneForDependency(redisState),
          pill: dependencyLabel(redisState),
          detail: 'Refresh sessions, WS tickets and cross-instance Pub/Sub',
        }
      : readiness.state === 'loading'
        ? { title: 'Redis', tone: 'idle', pill: 'checking', detail: 'GET /readyz …' }
        : { title: 'Redis', tone: 'down', pill: 'unknown', detail: readiness.message };

  return (
    <div className="space-y-10">
      <section className="space-y-5">
        <h1 className="max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          Write code together, in real time.
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-zinc-400 sm:text-base">
          A collaborative code editor built on Monaco, the editor inside VS Code. Changes travel
          over authenticated WebSockets, merge as Yjs CRDTs, reach every server instance through
          Redis Pub/Sub, and are stored as binary snapshots in PostgreSQL.
        </p>
        <div className="flex flex-wrap gap-3">
          {isAuthenticated ? (
            <Link
              to="/dashboard"
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500"
            >
              Open your documents
            </Link>
          ) : (
            <>
              <Link
                to="/register"
                className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-500"
              >
                Create an account
              </Link>
              <Link
                to="/login"
                className="rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-200 transition hover:bg-zinc-800"
              >
                Sign in
              </Link>
            </>
          )}
        </div>
      </section>

      <section aria-labelledby="features-heading" className="space-y-4">
        <h2 id="features-heading" className="sr-only">
          Features
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <li
              key={feature.title}
              className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4"
            >
              <h3 className="text-sm font-medium text-zinc-100">{feature.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{feature.text}</p>
            </li>
          ))}
        </ul>
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
    </div>
  );
}
