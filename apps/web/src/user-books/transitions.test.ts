import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { StrategySnapshot, TrialSnapshot, UserBookDetail } from './api';
import { userBookQueryKeys } from './queryKeys';
import { applyTransition, userBookListQueryKey } from './transitions';

const userBook: UserBookDetail = {
  id: 'book-1',
  workflowStatus: 'trial_review',
  updatedAt: '2026-07-16T00:00:00.000Z',
  sharedBook: {
    id: 'shared-1',
    status: 'ready',
    title: 'Book',
    authors: ['Author'],
    coverPath: null,
    errorSummary: null,
  },
  readingProgress: null,
  currentStrategyDraftVersionId: 'draft-1',
  currentStrategyVersionId: null,
  currentTrialRevisionId: 'trial-1',
};

const strategy: StrategySnapshot = {
  draftId: 'draft-2',
  draftVersion: 2,
  readingBriefing: {
    bookIdentity: '定位',
    arc: '脉络',
    assumedKnowledge: '前提',
    readingAdvice: '建议',
  },
  userFacingSummary: '新策略',
  trialCandidatePreviews: [],
  adjustmentCount: 1,
  adjustmentLimit: 5,
  canAdjust: true,
};

const trial: TrialSnapshot = {
  revisionId: 'trial-2',
  revision: 2,
  draftId: 'draft-2',
  status: 'generating',
  progress: { completed: 0, total: 3 },
  adjustmentCount: 1,
  adjustmentLimit: 5,
  canAdjust: true,
  canAdopt: false,
  samples: [],
  errorSummary: null,
};

function setup() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(userBookQueryKeys.detail(userBook.id), userBook);
  queryClient.setQueryData(userBookListQueryKey, { userBooks: [userBook] });
  return queryClient;
}

describe('applyTransition', () => {
  it('commits a strategy to exact, detail, and shelf caches before invalidation', async () => {
    const queryClient = setup();

    await applyTransition(queryClient, userBook.id, { type: 'strategy_committed', strategy });

    expect(queryClient.getQueryData(userBookQueryKeys.strategy(userBook.id, strategy.draftId)))
      .toEqual(strategy);
    expect(queryClient.getQueryData<UserBookDetail>(userBookQueryKeys.detail(userBook.id)))
      .toMatchObject({
        workflowStatus: 'strategy_review',
        currentStrategyDraftVersionId: 'draft-2',
        currentTrialRevisionId: null,
      });
    expect(queryClient.getQueryData<{ userBooks: UserBookDetail[] }>(userBookListQueryKey)?.userBooks[0])
      .toMatchObject({ workflowStatus: 'strategy_review' });
    expect(queryClient.getQueryState(userBookQueryKeys.detail(userBook.id))?.isInvalidated).toBe(true);
  });

  it('commits a trial and derives its workflow status from the trial snapshot', async () => {
    const queryClient = setup();

    await applyTransition(queryClient, userBook.id, { type: 'trial_committed', trial });

    expect(queryClient.getQueryData(userBookQueryKeys.trial(userBook.id, trial.revisionId)))
      .toEqual(trial);
    expect(queryClient.getQueryData<UserBookDetail>(userBookQueryKeys.detail(userBook.id)))
      .toMatchObject({
        workflowStatus: 'trial_generating',
        currentStrategyDraftVersionId: 'draft-2',
        currentTrialRevisionId: 'trial-2',
      });
  });

  it('uses the authoritative adopted book snapshot for the reading transition', async () => {
    const queryClient = setup();
    const adopted = {
      ...userBook,
      workflowStatus: 'active_reading' as const,
      currentStrategyVersionId: 'strategy-1',
    };

    await applyTransition(queryClient, userBook.id, { type: 'reading_started', userBook: adopted });

    expect(queryClient.getQueryData(userBookQueryKeys.detail(userBook.id))).toEqual(adopted);
    expect(queryClient.getQueryData<{ userBooks: UserBookDetail[] }>(userBookListQueryKey)?.userBooks[0])
      .toEqual(adopted);
  });
});
