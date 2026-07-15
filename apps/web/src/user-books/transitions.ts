import type { QueryClient } from '@tanstack/react-query';
import type { UserBookWorkflowStatus } from '@readtailor/contracts';
import type { InterviewSnapshot } from './api/interview';
import type {
  UserBookDetail,
  UserBookListResponse,
  UserBookSummary,
} from './api/http';
import type { StrategySnapshot } from './api/strategy';
import type { TrialSnapshot } from './api/trial';
import { userBookQueryKeys } from './queryKeys';

export const userBookListQueryKey = ['user-books'] as const;

export type ReadingSetupTransition =
  | { type: 'interview_started'; interview: InterviewSnapshot }
  | { type: 'strategy_committed'; strategy: StrategySnapshot }
  | { type: 'trial_committed'; trial: TrialSnapshot }
  | { type: 'reading_started'; userBook: UserBookDetail };

function transitionUpdatedAt(current: string, candidate = current): string {
  const currentTime = Date.parse(current);
  const candidateTime = Date.parse(candidate);
  if (!Number.isFinite(currentTime)) return candidate;
  return new Date(Math.max(currentTime + 1, Number.isFinite(candidateTime) ? candidateTime : 0)).toISOString();
}

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
  if (transition.type === 'reading_started') {
    if (!current) return transition.userBook;
    return {
      ...transition.userBook,
      updatedAt: transitionUpdatedAt(current.updatedAt, transition.userBook.updatedAt),
    };
  }
  if (!current) return current;
  if (transition.type === 'interview_started') {
    return {
      ...current,
      workflowStatus: 'interviewing',
      updatedAt: transitionUpdatedAt(current.updatedAt),
    };
  }
  if (transition.type === 'strategy_committed') {
    return {
      ...current,
      workflowStatus: 'strategy_review',
      updatedAt: transitionUpdatedAt(current.updatedAt),
      currentStrategyDraftVersionId: transition.strategy.draftId,
      currentTrialRevisionId: null,
    };
  }
  return {
    ...current,
    workflowStatus: workflowStatus(transition),
    updatedAt: transitionUpdatedAt(current.updatedAt),
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
  if (transition.type === 'reading_started') {
    return {
      ...transition.userBook,
      updatedAt: transitionUpdatedAt(current.updatedAt, transition.userBook.updatedAt),
    };
  }
  return {
    ...current,
    workflowStatus: workflowStatus(transition),
    updatedAt: transitionUpdatedAt(current.updatedAt),
  };
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
