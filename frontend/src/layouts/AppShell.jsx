import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../auth/useAuth.js';

const NAV_LINK =
  'rounded-md px-3 py-1.5 text-zinc-400 transition hover:bg-zinc-800/60 hover:text-zinc-100';
const NAV_ACTIVE = 'bg-zinc-800/60 text-zinc-100';

/**
 * Application chrome shared by every page except the full-screen editor and
 * history views. Header and footer use the same container as the page, so
 * their edges line up at every width.
 *
 * @param {object} props
 * @param {import('react').ReactNode} props.children
 */
export function AppShell({ children }) {
  const { user, isAuthenticated, isLoading, logout } = useAuth();
  const navClass = ({ isActive }) => `${NAV_LINK} ${isActive ? NAV_ACTIVE : ''}`;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100">
      <header className="border-b border-zinc-800/80 bg-zinc-900/40 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <Link to="/" className="group flex min-w-0 items-center gap-2.5" aria-label="Home">
            <span className="grid size-8 shrink-0 place-items-center rounded-md bg-emerald-500/15 font-mono text-sm text-emerald-300 ring-1 ring-inset ring-emerald-500/30">
              &lt;/&gt;
            </span>
            <span className="hidden truncate text-sm font-semibold tracking-tight text-zinc-100 group-hover:text-white sm:inline">
              Collaborative Code Editor
            </span>
          </Link>

          <nav className="flex shrink-0 items-center gap-1 text-sm" aria-label="Main">
            <NavLink to="/" end className={navClass}>
              Home
            </NavLink>
            {isAuthenticated && (
              <NavLink to="/dashboard" className={navClass}>
                Documents
              </NavLink>
            )}

            {isLoading ? (
              <div
                className="ml-2 size-5 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400"
                role="status"
                aria-label="Checking your session"
              />
            ) : isAuthenticated ? (
              <div className="ml-1 flex items-center gap-1">
                <span
                  className="hidden max-w-40 truncate rounded-md bg-zinc-800/60 px-2 py-1 text-xs text-zinc-400 md:inline"
                  title={user?.email}
                >
                  {user?.name}
                </span>
                <button type="button" onClick={logout} className={NAV_LINK}>
                  Sign out
                </button>
              </div>
            ) : (
              <Link
                to="/login"
                className="ml-1 rounded-md bg-zinc-100 px-3 py-1.5 font-medium text-zinc-900 transition hover:bg-white"
              >
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10">{children}</main>

      <footer className="border-t border-zinc-800/80">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-5 text-xs text-zinc-500 sm:px-6">
          <span>Monaco · Yjs CRDT · WebSockets · Redis Pub/Sub · PostgreSQL</span>
          <span>Edits merge conflict-free across every server instance.</span>
        </div>
      </footer>
    </div>
  );
}
