// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBookDetail } from './api/http';
import { mergeUserBookDetail, ReadingSetupRoute } from './ReadingSetupRoute';
import { userBookQueryKeys } from './queryKeys';
import { routeForWorkflow } from './routes';
import { applyTransition } from './transitions';
import { useReadingSetupWorkflow } from './useReadingSetupWorkflow';

const apiMocks = vi.hoisted(() => ({ getUserBook: vi.fn() }));

vi.mock('./api/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/http')>();
  return { ...actual, getUserBook: apiMocks.getUserBook };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<ReturnType<typeof createRoot>> = [];

async function waitFor(assertion: () => void | Promise<void>) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}

beforeEach(() => {
  apiMocks.getUserBook.mockReset();
});

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

    await waitFor(() => {
      expect(host.textContent).toBe('/user-books/book-1/strategy|strategy_review');
    });
  });

  it('accepts a later server workflow even when an old cache entry has a newer timestamp', () => {
    const cached = {
      ...detail('interviewing'),
      updatedAt: '2026-07-16T00:10:00.000Z',
    };
    const completed = {
      ...detail('strategy_review'),
      updatedAt: '2026-07-16T00:09:59.000Z',
    };

    expect(mergeUserBookDetail(cached, completed)).toMatchObject({
      workflowStatus: 'strategy_review',
      currentStrategyDraftVersionId: 'draft-1',
      updatedAt: cached.updatedAt,
    });
  });

  it('does not let an older deferred detail response overwrite a transition pointer', async () => {
    let resolveDetail: ((value: UserBookDetail) => void) | null = null;
    apiMocks.getUserBook.mockImplementation(() => new Promise<UserBookDetail>((resolve) => {
      resolveDetail = resolve;
    }));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    const oldDetail = detail('interviewing');
    queryClient.setQueryData(userBookQueryKeys.detail('book-1'), oldDetail);
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
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => expect(apiMocks.getUserBook).toHaveBeenCalled());

    let transitionPromise: Promise<void> | null = null;
    await act(async () => {
      transitionPromise = applyTransition(queryClient, 'book-1', {
        type: 'strategy_committed',
        strategy: {
          draftId: 'draft-new',
          draftVersion: 2,
          readingBriefing: {
            bookIdentity: '定位',
            arc: '脉络',
            assumedKnowledge: '前提',
            readingAdvice: '建议',
          },
          userFacingSummary: '策略',
          trialCandidatePreviews: [],
          adjustmentCount: 0,
          adjustmentLimit: 5,
          canAdjust: true,
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(queryClient.getQueryData<UserBookDetail>(userBookQueryKeys.detail('book-1')))
        .toMatchObject({ workflowStatus: 'strategy_review', currentStrategyDraftVersionId: 'draft-new' });
    });

    await act(async () => {
      resolveDetail!(oldDetail);
      await transitionPromise;
    });

    expect(queryClient.getQueryData<UserBookDetail>(userBookQueryKeys.detail('book-1')))
      .toMatchObject({ workflowStatus: 'strategy_review', currentStrategyDraftVersionId: 'draft-new' });
  });
});

describe('routeForWorkflow', () => {
  it.each([
    ['on_shelf', 'reading-setup'],
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
