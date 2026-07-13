import type { ReactNode } from 'react';
import { Link } from 'react-router';

export function LibraryChrome({ children, service }: {
  children: ReactNode;
  service?: { connected: boolean; pending: boolean };
}) {
  return (
    <div className="app-shell">
      <header className="masthead">
        <Link className="brand" to="/" aria-label="裁读书架">
          <span className="brand-cn">裁读</span>
          <span className="brand-en">READTAILOR</span>
        </Link>
        {service ? (
          <div className="service-state" data-connected={service.connected}>
            <span className="service-dot" aria-hidden="true" />
            {service.pending ? '正在连接' : service.connected ? '服务正常' : '服务未连接'}
          </div>
        ) : (
          <Link className="masthead-back" to="/">‹ 返回书架</Link>
        )}
      </header>
      {children}
    </div>
  );
}
