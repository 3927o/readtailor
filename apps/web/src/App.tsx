import { useQuery } from '@tanstack/react-query';
import type { HealthResponse } from '@readtailor/contracts';
import { Route, Routes } from 'react-router';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001';

async function getHealth(): Promise<HealthResponse> {
  const response = await fetch(`${apiBaseUrl}/v1/health`);
  if (!response.ok) {
    throw new Error('API health check failed');
  }
  return response.json() as Promise<HealthResponse>;
}

function ShelfPage() {
  const health = useQuery({ queryKey: ['api-health'], queryFn: getHealth });
  const connected = health.data?.status === 'ok';

  return (
    <div className="app-shell">
      <header className="masthead">
        <a className="brand" href="/" aria-label="裁读书架">
          <span className="brand-cn">裁读</span>
          <span className="brand-en">READTAILOR</span>
        </a>
        <div className="service-state" data-connected={connected}>
          <span className="service-dot" aria-hidden="true" />
          {health.isPending ? '正在连接' : connected ? '服务正常' : '服务未连接'}
        </div>
      </header>

      <main className="shelf">
        <div className="section-heading">
          <div>
            <p className="kicker">LIBRARY · 书架</p>
            <h1>你的书</h1>
          </div>
        </div>

        <section className="empty-shelf" aria-labelledby="empty-title">
          <div className="quote-corners" aria-hidden="true">⌜　⌟</div>
          <h2 id="empty-title">书架还空着</h2>
          <p>第一本书准备好后，会出现在这里。</p>
        </section>
      </main>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="*" element={<ShelfPage />} />
    </Routes>
  );
}
