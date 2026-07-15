// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserBookDetail } from './api';
import { ReadingSetupRoute } from './ReadingSetupRoute';
import { userBookQueryKeys } from './queryKeys';
import { routeForWorkflow } from './routes';
import { useReadingSetupWorkflow } from './useReadingSetupWorkflow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function Probe() {
  const location = useLocation();
  const { userBook } = useReadingSetupWorkflow();
  return <span>{location.pathname}|{userBook.workflowStatus}</span>;
}

function detail(workflowStatus: UserBookDetail['workflowStatus']): UserBookDetail {
  return {
    id: 'book-1',
    workflowStatus,
    updatedAt: '2026-07-16T00:00:00.000Z',
    sharedBook: {
      id: 'shared-1',
      status: 'ready',
      title: 'Book',
      authors: [],
      coverPath: null,
      errorSummary: null,
    },
    readingProgress: null,
    currentStrategyDraftVersionId: workflowStatus === 'strategy_review' ? 'draft-1' : null,
    currentStrategyVersionId: workflowStatus === 'active_reading' ? 'strategy-1' : null,
    currentTrialRevisionId: null,
  };
}

describe('ReadingSetupRoute', () => {
  it('owns canonical workflow navigation and exposes the same detail through outlet context', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(userBookQueryKeys.detail('book-1'), detail('strategy_review'));
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/user-books/book-1/interview']}>
            <Routes>
              <Route path="/user-books/:id" element={<ReadingSetupRoute />}>
                <Route path="interview" element={<Probe />} />
                <Route path="strategy" element={<Probe />} />
                <Route path="trial" element={<Probe />} />
                <Route path="read" element={<Probe />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(host.textContent).toBe('/user-books/book-1/strategy|strategy_review');
    });
  });
});

describe('routeForWorkflow', () => {
  it.each([
    ['on_shelf', 'interview'],
    ['interviewing', 'interview'],
    ['strategy_review', 'strategy'],
    ['trial_generating', 'trial'],
    ['trial_generation_failed', 'trial'],
    ['trial_review', 'trial'],
    ['active_reading', 'read'],
  ] as const)('maps %s to the %s route', (status, suffix) => {
    expect(routeForWorkflow('book/1', status)).toBe(`/user-books/book%2F1/${suffix}`);
  });
});
