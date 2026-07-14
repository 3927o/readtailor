import { useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { useAuth } from '../auth/AuthProvider';

export function LibraryChrome({ children, service, showBack = true }: {
  children: ReactNode;
  service?: { connected: boolean; pending: boolean };
  showBack?: boolean;
}) {
  const auth = useAuth();
  const [logoutPending, setLogoutPending] = useState(false);
  return (
    <div className="app-shell">
      <header className="masthead">
        <Link className="brand" to="/" aria-label="裁读书架">
          <span className="brand-cn">裁读</span>
          <span className="brand-en">READTAILOR</span>
        </Link>
        <div className="masthead-actions">
          <nav className="masthead-nav" aria-label="主导航">
            <NavLink to="/" end>书架</NavLink>
            <NavLink to="/stats">统计</NavLink>
          </nav>
          {service ? (
            <div className="service-state" data-connected={service.connected}>
              <span className="service-dot" aria-hidden="true" />
              {service.pending ? '正在连接' : service.connected ? '服务正常' : '服务未连接'}
            </div>
          ) : showBack ? (
            <Link className="masthead-back" to="/">‹ 返回书架</Link>
          ) : (
            <span className="masthead-spacer" aria-hidden="true" />
          )}
          {auth.user ? (
            <div className="account-menu">
              {auth.user.avatarUrl ? (
                <img src={auth.user.avatarUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <span className="account-initial" aria-hidden="true">
                  {auth.user.displayName.slice(0, 1).toUpperCase()}
                </span>
              )}
              <span className="account-name">{auth.user.displayName}</span>
              <button
                className="account-logout"
                type="button"
                disabled={logoutPending}
                onClick={() => {
                  setLogoutPending(true);
                  void auth.logout().finally(() => setLogoutPending(false));
                }}
              >
                {logoutPending ? '退出中' : '退出'}
              </button>
            </div>
          ) : null}
        </div>
      </header>
      {children}
    </div>
  );
}
