// @vitest-environment happy-dom
/** Verifies that the application exposes only the new Setup and direct Reader routes. */

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Outlet } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

vi.mock('./auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children?: ReactNode }) => children ?? <Outlet />,
}));
vi.mock('./auth/LoginPage', () => ({ LoginPage: () => <div>login-page</div> }));
vi.mock('./auth/OnboardingPage', () => ({ OnboardingPage: () => <div>onboarding-page</div> }));
vi.mock('./library/ImportPage', () => ({ ImportPage: () => <div>import-page</div> }));
vi.mock('./library/ProcessingPage', () => ({ ProcessingPage: () => <div>processing-page</div> }));
vi.mock('./library/ShelfPage', () => ({ ShelfPage: () => <div>shelf-page</div> }));
vi.mock('./reader/ReaderPage', () => ({ ReaderPage: () => <div>reader-page</div> }));
vi.mock('./reading-setup/ReadingSetupPage', () => ({
  ReadingSetupPage: () => <div>reading-setup-page</div>,
}));
vi.mock('./reading-stats/StatsPage', () => ({ StatsPage: () => <div>stats-page</div> }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;

async function renderPath(path: string): Promise<string> {
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  return container.textContent ?? '';
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe('user-book routes', () => {
  it.each(['interview', 'strategy', 'trial'])(
    'redirects the retired %s path to the shelf',
    async (path) => {
      await expect(renderPath(`/user-books/book-1/${path}`)).resolves.toContain('shelf-page');
    },
  );

  it('mounts Reader directly and keeps the new Setup entry', async () => {
    await expect(renderPath('/user-books/book-1/read')).resolves.toContain('reader-page');
    await act(async () => root?.unmount());
    root = null;
    await expect(renderPath('/user-books/book-1/reading-setup'))
      .resolves.toContain('reading-setup-page');
  });
});
