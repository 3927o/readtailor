// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StrategySnapshot, TrialSnapshot, UserBookDetail } from './api';
import { userBookQueryKeys } from './queryKeys';
import { useStrategyReviewController } from './useStrategyReviewController';
import { useTrialReviewController } from './useTrialReviewController';

const mocks = vi.hoisted(() => ({
  getStrategy: vi.fn(),
  getTrial: vi.fn(),
  markViewed: vi.fn(),
  retryTrial: vi.fn(),
  adoptTrial: vi.fn(),
  revisionHook: vi.fn(),
  selectionHook: vi.fn(),
  revisionSubmit: vi.fn(),
  selectionSubmit: vi.fn(),
  selectOrdinal: vi.fn(),
}));

vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    getStrategy: mocks.getStrategy,
    getTrial: mocks.getTrial,
    markTrialSampleViewed: mocks.markViewed,
    retryTrial: mocks.retryTrial,
    adoptTrial: mocks.adoptTrial,
  };
});

vi.mock('./useStrategyRevisionFlow', () => ({
  useStrategyRevisionFlow: mocks.revisionHook,
}));

vi.mock('./useTrialSelectionFlow', () => ({
  useTrialSelectionFlow: mocks.selectionHook,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const userBook: UserBookDetail = {
  id: 'book-1',
  workflowStatus: 'strategy_review',
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
  currentStrategyDraftVersionId: 'draft-1',
  currentStrategyVersionId: null,
  currentTrialRevisionId: null,
};

const strategy: StrategySnapshot = {
  draftId: 'draft-1',
  draftVersion: 1,
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
};

const trial: TrialSnapshot = {
  revisionId: 'trial-1',
  revision: 1,
  draftId: 'draft-1',
  status: 'ready',
  progress: { completed: 3, total: 3 },
  adjustmentCount: 0,
  adjustmentLimit: 5,
  canAdjust: true,
  canAdopt: true,
  samples: [1, 2, 3].map((ordinal) => ({
    id: `sample-${ordinal}`,
    ordinal,
    status: 'ready' as const,
    sectionId: `section-${ordinal}`,
    segment: ordinal,
    chapterPath: [`章节 ${ordinal}`],
    selectionReason: '原因',
    originalHtml: '<p>原文</p>',
    viewedAt: null,
    tailoredContent: { guide: null, annotations: [], afterReading: null },
  })),
  errorSummary: null,
};

const roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  mocks.getStrategy.mockReset().mockResolvedValue(strategy);
  mocks.getTrial.mockReset().mockResolvedValue(trial);
  mocks.markViewed.mockReset().mockImplementation(async (_bookId, _revisionId, sampleId) => ({
    ...trial,
    samples: trial.samples.map((sample) => sample.id === sampleId
      ? { ...sample, viewedAt: '2026-07-16T00:00:00.000Z' }
      : sample),
  }));
  mocks.retryTrial.mockReset().mockResolvedValue({
    ...trial,
    revisionId: 'trial-2',
    revision: 2,
    status: 'generating',
    canAdopt: false,
  });
  mocks.adoptTrial.mockReset().mockResolvedValue({
    ...userBook,
    workflowStatus: 'active_reading',
    currentStrategyVersionId: 'strategy-1',
    currentTrialRevisionId: 'trial-1',
  });
  mocks.revisionSubmit.mockReset();
  mocks.selectionSubmit.mockReset();
  mocks.selectOrdinal.mockReset();
  mocks.revisionHook.mockReset().mockReturnValue({
    state: {
      mode: 'idle',
      finalStrategy: null,
      strategySummary: '',
      nodes: [],
      error: null,
    },
    submit: mocks.revisionSubmit,
    pending: false,
    active: false,
    error: null,
  });
  mocks.selectionHook.mockReset().mockReturnValue({
    state: {
      mode: 'idle',
      finalTrial: null,
      slots: [],
      activeOrdinal: 1,
    },
    submit: mocks.selectionSubmit,
    selectOrdinal: mocks.selectOrdinal,
    pending: false,
    active: false,
    error: null,
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

async function waitFor(assertion: () => void | Promise<void>) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}

describe('useStrategyReviewController', () => {
  it('combines the canonical query with revision and approval adapters', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let controller: ReturnType<typeof useStrategyReviewController> | null = null;
    const value = () => controller!;

    function Harness() {
      controller = useStrategyReviewController({
        userBookId: userBook.id,
        userBook,
        onRevisionCompleted: () => {},
        onRecoverableFeedback: () => {},
      });
      return null;
    }

    const root = createRoot(document.createElement('div'));
    roots.push(root);
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    });
    await waitFor(() => expect(value().snapshot?.draftId).toBe('draft-1'));

    act(() => {
      value().submitFeedback('更简洁');
      value().approve();
      value().selectTrialOrdinal(2);
    });

    expect(mocks.revisionSubmit).toHaveBeenCalledWith('更简洁');
    expect(mocks.selectionSubmit).toHaveBeenCalledTimes(1);
    expect(mocks.selectOrdinal).toHaveBeenCalledWith(2);
    expect(value().strategyModel).toMatchObject({ mode: 'committed', strategySummary: '策略' });
  });
});

describe('useTrialReviewController', () => {
  it('records viewed state, retries through transition, and adopts without an idempotency key', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const trialBook = { ...userBook, workflowStatus: 'trial_review' as const, currentTrialRevisionId: 'trial-1' };
    queryClient.setQueryData(userBookQueryKeys.detail(userBook.id), trialBook);
    const reset = vi.fn();
    let controller: ReturnType<typeof useTrialReviewController> | null = null;
    const value = () => controller!;

    function Harness() {
      controller = useTrialReviewController({
        userBookId: userBook.id,
        userBook: trialBook,
        activeOrdinal: 1,
        onRevisionCompleted: () => {},
        onRecoverableFeedback: () => {},
        onTrialReset: reset,
      });
      return null;
    }

    const root = createRoot(document.createElement('div'));
    roots.push(root);
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    });
    await waitFor(() => expect(value().snapshot?.revisionId).toBe('trial-1'));
    await waitFor(() => expect(mocks.markViewed).toHaveBeenCalledWith('book-1', 'trial-1', 'sample-1'));

    act(() => value().adopt());
    await waitFor(() => expect(mocks.adoptTrial).toHaveBeenCalledTimes(1));
    expect(mocks.adoptTrial.mock.calls[0]).toEqual(['book-1', 'trial-1', 'draft-1']);

    act(() => value().retryTrial());
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(queryClient.getQueryData(userBookQueryKeys.trial('book-1', 'trial-2')))
      .toMatchObject({ revisionId: 'trial-2', status: 'generating' });
  });
});
