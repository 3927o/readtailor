import type { QueryClient } from '@tanstack/react-query';
import type { UserBookWorkflowStatus } from '@readtailor/contracts';
import type {
  InterviewSnapshot,
  StrategySnapshot,
  TrialSnapshot,
  UserBookDetail,
  UserBookListResponse,
  UserBookSummary,
} from './api';
import { userBookQueryKeys } from './queryKeys';

export const userBookListQueryKey = ['user-books'] as const;

export type ReadingSetupTransition =
  | { type: 'interview_started'; interview: InterviewSnapshot }
  | { type: 'strategy_committed'; strategy: StrategySnapshot }
  | { type: 'trial_committed'; trial: TrialSnapshot }
  | { type: 'reading_started'; userBook: UserBookDetail };

function workflowStatus(transition: ReadingSetupTransition): UserBookWorkflowStatus {
  switch (transition.type) {
    case 'interview_started': return 'interviewing';
    case 'strategy_committed': return 'strategy_review';
    case 'trial_committed':
      return transition.trial.status === 'failed'
        ? 'trial_generation_failed'
        : transition.trial.status === 'ready'
          ? 'trial_review'
          : 'trial_generating';
    case 'reading_started': return transition.userBook.workflowStatus;
  }
}

function updateDetail(
  current: UserBookDetail | undefined,
  transition: ReadingSetupTransition,
): UserBookDetail | undefined {
  if (transition.type === 'reading_started') return transition.userBook;
  if (!current) return current;
  if (transition.type === 'interview_started') {
    return { ...current, workflowStatus: 'interviewing' };
  }
  if (transition.type === 'strategy_committed') {
    return {
      ...current,
      workflowStatus: 'strategy_review',
      currentStrategyDraftVersionId: transition.strategy.draftId,
      currentTrialRevisionId: null,
    };
  }
  return {
    ...current,
    workflowStatus: workflowStatus(transition),
    currentStrategyDraftVersionId: transition.trial.draftId,
    currentTrialRevisionId: transition.trial.revisionId,
  };
}

function updateListItem(
  current: UserBookSummary,
  userBookId: string,
  transition: ReadingSetupTransition,
): UserBookSummary {
  if (current.id !== userBookId) return current;
  if (transition.type === 'reading_started') return transition.userBook;
  return { ...current, workflowStatus: workflowStatus(transition) };
}

export async function applyTransition(
  queryClient: QueryClient,
  userBookId: string,
  transition: ReadingSetupTransition,
): Promise<void> {
  if (transition.type === 'interview_started') {
    queryClient.setQueryData(userBookQueryKeys.interview(userBookId), transition.interview);
  } else if (transition.type === 'strategy_committed') {
    queryClient.setQueryData(
      userBookQueryKeys.strategy(userBookId, transition.strategy.draftId),
      transition.strategy,
    );
  } else if (transition.type === 'trial_committed') {
    queryClient.setQueryData(
      userBookQueryKeys.trial(userBookId, transition.trial.revisionId),
      transition.trial,
    );
  }

  queryClient.setQueryData<UserBookDetail>(
    userBookQueryKeys.detail(userBookId),
    (current) => updateDetail(current, transition),
  );
  queryClient.setQueryData<UserBookListResponse>(userBookListQueryKey, (current) => current ? {
    ...current,
    userBooks: current.userBooks.map((item) => updateListItem(item, userBookId, transition)),
  } : current);

  await Promise.all([
    queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(userBookId) }),
    queryClient.invalidateQueries({ queryKey: userBookListQueryKey, exact: true }),
  ]);
}
