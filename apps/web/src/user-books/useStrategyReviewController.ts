import { useQuery } from '@tanstack/react-query';
import { bookAssetBaseUrl } from '../library/api';
import { getStrategy, type UserBookDetail } from './api';
import type { ProgressiveStrategyModel } from './ProgressiveStrategyView';
import type { ProgressiveTrialModel } from './ProgressiveTrialView';
import { userBookQueryKeys } from './queryKeys';
import { useStrategyRevisionFlow } from './useStrategyRevisionFlow';
import { useTrialSelectionFlow } from './useTrialSelectionFlow';

export function useStrategyReviewController(options: {
  userBookId: string;
  userBook: UserBookDetail;
  onRevisionCompleted(): void;
  onRecoverableFeedback(feedback: string): void;
}) {
  const currentDraftId = options.userBook.currentStrategyDraftVersionId ?? '';
  const strategy = useQuery({
    queryKey: userBookQueryKeys.strategy(options.userBookId, currentDraftId),
    queryFn: () => getStrategy(options.userBookId, currentDraftId),
    enabled: Boolean(currentDraftId),
  });
  const revision = useStrategyRevisionFlow({
    userBookId: options.userBookId,
    source: 'strategy_feedback',
    baseDraftId: currentDraftId,
    baseTrialRevisionId: null,
    enabled: Boolean(currentDraftId),
    onCompleted: options.onRevisionCompleted,
    onRecoverableFeedback: options.onRecoverableFeedback,
  });
  const selection = useTrialSelectionFlow({
    userBookId: options.userBookId,
    draftId: currentDraftId,
    enabled: Boolean(currentDraftId),
  });
  const snapshot = strategy.data ?? null;
  const visibleStrategy = revision.state.finalStrategy ?? snapshot;
  const selectionSamples = selection.state.finalTrial?.samples
    ?? selection.state.slots.flatMap((slot) => slot.sample ? [slot.sample] : []);
  const strategyModel: ProgressiveStrategyModel | null = snapshot && visibleStrategy
    ? revision.active
      ? {
          mode: revision.state.mode === 'completed'
            ? 'committed'
            : revision.state.mode === 'recovering'
              ? 'recovering'
              : 'streaming',
          source: 'strategy_feedback',
          briefing: snapshot.readingBriefing,
          strategySummary: revision.state.strategySummary,
          nodes: revision.state.nodes,
          ...(revision.state.finalStrategy
            ? { draftVersion: revision.state.finalStrategy.draftVersion }
            : {}),
          ...(revision.state.error ? { error: revision.state.error } : {}),
        }
      : {
          mode: 'committed',
          source: 'interview',
          briefing: visibleStrategy.readingBriefing,
          strategySummary: visibleStrategy.userFacingSummary,
          nodes: visibleStrategy.trialCandidatePreviews,
          draftVersion: visibleStrategy.draftVersion,
        }
    : null;
  const trialModel: ProgressiveTrialModel = {
    mode: selection.state.mode === 'recovering'
      ? 'recovering'
      : selection.state.mode === 'completed'
        ? 'generating'
        : 'selecting',
    samples: selectionSamples,
    activeOrdinal: selection.state.activeOrdinal,
    assetBaseUrl: bookAssetBaseUrl(options.userBook.sharedBook.id),
  };

  return {
    loading: strategy.isPending,
    loadError: strategy.error,
    retryLoad: () => void strategy.refetch(),
    snapshot,
    strategyModel,
    trialModel,
    selectionActive: selection.active,
    selectTrialOrdinal: selection.selectOrdinal,
    submitFeedback: revision.submit,
    approve: selection.submit,
    feedbackPending: revision.active || revision.pending,
    approvePending: selection.pending,
    approveDisabled: selection.pending || revision.active,
    mutationError: revision.error ?? selection.error,
  };
}
