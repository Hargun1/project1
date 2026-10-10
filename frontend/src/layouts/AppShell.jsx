import { Link } from 'react-router-dom';
import { useAuth } from '../auth/useAuth.js';

/**
 * Application chrome shared by every page.
 * Shows user info + logout when authenticated, sign-in button otherwise.
 *
 * @param {object} props
 * @param {import('react').ReactNode} props.children
 */
export function AppShell({ children }) {
  const { user, isAuthenticated, isLoading, logout } = useAuth();

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800/80 bg-zinc-900/40 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-4">
          <Link to="/" className="group flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-md bg-emerald-500/15 font-mono text-sm text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
              &lt;/&gt;
            </span>
            <span className="text-sm font-semibold tracking-tight text-zinc-100 group-hover:text-white">
              Collaborative Code Editor
            </span>
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            <Link
              to="/"
              className="rounded-md px-3 py-1.5 text-zinc-400 transition hover:bg-zinc-800/60 hover:text-zinc-100"
            >
              Status
            </Link>
            {isAuthenticated && (
              <Link
                to="/dashboard"
                className="rounded-md px-3 py-1.5 text-zinc-400 transition hover:bg-zinc-800/60 hover:text-zinc-100"
              >
                Dashboard
              </Link>
            )}

            {isLoading ? (
              <div className="size-5 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400" />
            ) : isAuthenticated ? (
              <div className="flex items-center gap-2">
                <span className="rounded-md px-2 py-1 text-xs text-zinc-400 bg-zinc-800/60">
                  {user?.name}
                </span>
                <button
                  onClick={logout}
                  className="rounded-md px-3 py-1.5 text-zinc-400 transition hover:bg-zinc-800/60 hover:text-zinc-100"
                >
                  Sign out
                </button>
              </div>
            ) : (
              <Link
                to="/login"
                className="rounded-md bg-zinc-100 px-3 py-1.5 font-medium text-zinc-900 transition hover:bg-white"
              >
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">{children}</main>

      <footer className="border-t border-zinc-800/80 px-6 py-5">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
          <span>Monaco · Yjs CRDT · Redis Pub/Sub · PostgreSQL</span>
          <span className="font-mono">phase 13 / 15 — testing</span>
        </div>
      </footer>
    </div>
  );
}
