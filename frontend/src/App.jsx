import { Route, Routes, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthProvider.jsx';
import { useAuth } from './auth/useAuth.js';
import { AppShell } from './layouts/AppShell.jsx';
import { LoginPage } from './pages/LoginPage.jsx';
import { RegisterPage } from './pages/RegisterPage.jsx';
import { NotFoundPage } from './pages/NotFoundPage.jsx';
import { StatusPage } from './pages/StatusPage.jsx';
import { DashboardPage } from './pages/DashboardPage.jsx';
import { EditorPage } from './pages/EditorPage.jsx';

/**
 * Redirects to /login if the user is not authenticated.
 * Shows a loading indicator while the initial auth check runs.
 */
function ProtectedRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="size-6 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return children;
}

/**
 * Redirects authenticated users away from login/register.
 */
function GuestRoute({ children }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="size-6 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-400" />
      </div>
    );
  }

  if (isAuthenticated) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}

/**
 * Route skeleton for the pages listed in the specification (§7).
 *
 * The editor route renders outside AppShell because the Monaco editor fills
 * the full viewport and manages its own chrome. Every other page sits inside
 * AppShell's nav + footer wrapper.
 */
function AppRoutes() {
  return (
    <Routes>
      {/* Full-screen editor — no AppShell chrome */}
      <Route
        path="/editor/:documentId"
        element={
          <ProtectedRoute>
            <EditorPage />
          </ProtectedRoute>
        }
      />

      {/* All other pages get the shared nav + footer */}
      <Route
        path="*"
        element={
          <AppShell>
            <Routes>
              <Route path="/" element={<StatusPage />} />
              <Route
                path="/login"
                element={
                  <GuestRoute>
                    <LoginPage />
                  </GuestRoute>
                }
              />
              <Route
                path="/register"
                element={
                  <GuestRoute>
                    <RegisterPage />
                  </GuestRoute>
                }
              />
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute>
                    <DashboardPage />
                  </ProtectedRoute>
                }
              />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </AppShell>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
