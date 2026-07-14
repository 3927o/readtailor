import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from './AuthProvider';

export function ProtectedRoute({
  children,
  requireCompletedProfile = true,
}: {
  children?: ReactNode;
  requireCompletedProfile?: boolean;
}) {
  const auth = useAuth();
  const location = useLocation();
  const content = children ?? <Outlet />;

  if (auth.isLoading) {
    return <main className="auth-state" aria-busy="true">正在确认登录状态…</main>;
  }
  if (auth.error) {
    return (
      <main className="auth-state" role="alert">
        <p>{auth.error.message}</p>
        <button
          type="button"
          onClick={() => { void auth.refresh().catch(() => undefined); }}
        >
          重新连接
        </button>
      </main>
    );
  }
  if (!auth.user) {
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate replace to={`/login?returnTo=${encodeURIComponent(returnTo)}`} />;
  }
  if (requireCompletedProfile && !auth.user.readerProfileCompleted) {
    return <Navigate replace to="/onboarding" />;
  }
  return content;
}
