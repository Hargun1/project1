import { Route, Routes } from 'react-router-dom';
import { AppShell } from './layouts/AppShell.jsx';
import { NotFoundPage } from './pages/NotFoundPage.jsx';
import { PlaceholderPage } from './pages/PlaceholderPage.jsx';
import { StatusPage } from './pages/StatusPage.jsx';

/**
 * Route skeleton for the pages listed in the specification (§7). Only the status
 * page has real behaviour in Phase 1; the rest are wired now so later phases add
 * a screen rather than rework navigation.
 */
export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<StatusPage />} />
        <Route
          path="/login"
          element={
            <PlaceholderPage
              title="Sign in"
              phase="Phase 2 — Authentication"
              description="Email + password login backed by JWT access tokens and a rotating refresh session stored in an HttpOnly cookie."
            />
          }
        />
        <Route
          path="/register"
          element={
            <PlaceholderPage
              title="Create an account"
              phase="Phase 2 — Authentication"
              description="Registration with Zod-validated input and Argon2/bcrypt password hashing."
            />
          }
        />
        <Route
          path="/dashboard"
          element={
            <PlaceholderPage
              title="Your documents"
              phase="Phase 3 — Documents"
              description="Paginated document list with search, language filter and per-document role."
            />
          }
        />
        <Route
          path="/editor/:documentId"
          element={
            <PlaceholderPage
              title="Editor"
              phase="Phase 4 — Monaco"
              description="Monaco Editor bound to a Y.Text, synchronised over an authenticated WebSocket."
            />
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AppShell>
  );
}
