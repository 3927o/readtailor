import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { bookAssetBaseUrl } from '../library/api';
import {
  adoptTrial,
  ApiError,
  getStrategy,
  getTrial,
  markTrialSampleViewed,
  retryTrial,
  type TrialSample,
  type TrialSnapshot,
  type UserBookDetail,
} from './api';
import type { ProgressiveStrategyModel } from './ProgressiveStrategyView';
import type { ProgressiveTrialModel } from './ProgressiveTrialView';
import { userBookQueryKeys } from './queryKeys';
import { applyTransition } from './transitions';
import { useStrategyRevisionFlow } from './useStrategyRevisionFlow';
import type { TrialOrdinal } from './trialSelectionStreamState';

export function useTrialReviewController(options: {
  userBookId: string;
  userBook: UserBookDetail;
  activeOrdinal: TrialOrdinal;
  onRevisionCompleted(): void;
  onRecoverableFeedback(feedback: string): void;
  onTrialReset(): void;
}) {
  const queryClient = useQueryClient();
  const viewedAttempts = useRef(new Set<string>());
  const currentTrialRevisionId = options.userBook.currentTrialRevisionId ?? '';
  const trial = useQuery({
    queryKey: userBookQueryKeys.trial(options.userBookId, currentTrialRevisionId),
    queryFn: () => getTrial(options.userBookId, currentTrialRevisionId),
    enabled: Boolean(currentTrialRevisionId),
    refetchInterval: (current) => current.state.data?.status === 'generating' ? 1000 : false,
  });
  const baseDraftId = trial.data?.draftId ?? '';
  const baseStrategy = useQuery({
    queryKey: userBookQueryKeys.strategy(options.userBookId, baseDraftId),
    queryFn: () => getStrategy(options.userBookId, baseDraftId),
    enabled: Boolean(baseDraftId),
  });
  const revision = useStrategyRevisionFlow({
    userBookId: options.userBookId,
    source: 'trial_feedback',
    baseDraftId,
    baseTrialRevisionId: currentTrialRevisionId || null,
    enabled: Boolean(baseDraftId && currentTrialRevisionId),
    onCompleted: options.onRevisionCompleted,
    onRecoverableFeedback: options.onRecoverableFeedback,
  });

  const resyncOnConflict = async (error: Error) => {
    if (error instanceof ApiError && error.status === 409) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(options.userBookId) }),
        queryClient.invalidateQueries({ queryKey: userBookQueryKeys.trials(options.userBookId) }),
      ]);
    }
  };
  const saveSnapshot = (snapshot: TrialSnapshot) => {
    queryClient.setQueryData(
      userBookQueryKeys.trial(options.userBookId, snapshot.revisionId),
      snapshot,
    );
  };
  const viewed = useMutation({
    mutationFn: (sample: TrialSample) => markTrialSampleViewed(
      options.userBookId,
      trial.data?.revisionId ?? '',
      sample.id,
    ),
    onSuccess: saveSnapshot,
    onError: resyncOnConflict,
  });
  const retry = useMutation({
    mutationFn: () => retryTrial(options.userBookId),
    onSuccess: async (snapshot) => {
      options.onTrialReset();
      viewedAttempts.current.clear();
      await applyTransition(queryClient, options.userBookId, {
        type: 'trial_committed',
        trial: snapshot,
      });
    },
    onError: resyncOnConflict,
  });
  const adopt = useMutation({
    mutationFn: () => {
      if (!trial.data) throw new Error('当前试读版本已经失效。');
      return adoptTrial(options.userBookId, trial.data.revisionId, trial.data.draftId);
    },
    onSuccess: (userBook) => {
      void applyTransition(queryClient, options.userBookId, {
        type: 'reading_started',
        userBook,
      });
    },
    onError: resyncOnConflict,
  });

  const samples = useMemo(
    () => [...(trial.data?.samples ?? [])].sort((left, right) => left.ordinal - right.ordinal),
    [trial.data?.samples],
  );
  const current = samples.find((sample) => sample.ordinal === options.activeOrdinal);
  useEffect(() => {
    viewedAttempts.current.clear();
  }, [trial.data?.revisionId]);
  useEffect(() => {
    if (!trial.data || trial.data.status !== 'ready' || !current || current.status !== 'ready' || current.viewedAt) return;
    const key = `${trial.data.revision}:${current.id}`;
    if (viewedAttempts.current.has(key)) return;
    viewedAttempts.current.add(key);
    viewed.mutate(current);
  }, [current, trial.data?.revision, trial.data?.status]);

  const retryViewed = () => {
    if (!trial.data || !current) return;
    viewedAttempts.current.delete(`${trial.data.revision}:${current.id}`);
    viewed.mutate(current);
  };
  const snapshot = trial.data ?? null;
  const trialModel: ProgressiveTrialModel | null = snapshot ? {
    mode: snapshot.status === 'ready' ? 'review' : snapshot.status,
    samples,
    activeOrdinal: options.activeOrdinal,
    assetBaseUrl: bookAssetBaseUrl(options.userBook.sharedBook.id),
    ...(snapshot.status === 'failed' && snapshot.errorSummary
      ? { error: snapshot.errorSummary }
      : {}),
  } : null;
  const revisionModel: ProgressiveStrategyModel = {
    mode: revision.state.mode === 'completed'
      ? 'committed'
      : revision.state.mode === 'recovering'
        ? 'recovering'
        : 'streaming',
    source: 'trial_feedback',
    briefing: baseStrategy.data?.readingBriefing ?? {},
    strategySummary: revision.state.strategySummary,
    nodes: revision.state.nodes,
    ...(revision.state.finalStrategy
      ? { draftVersion: revision.state.finalStrategy.draftVersion }
      : {}),
    ...(revision.state.error ? { error: revision.state.error } : {}),
  };

  return {
    loading: trial.isPending,
    loadError: trial.error,
    retryLoad: () => void trial.refetch(),
    snapshot,
    samples,
    current,
    trialModel,
    revisionModel,
    revisionActive: revision.active,
    submitFeedback: revision.submit,
    feedbackPending: revision.pending || baseStrategy.isPending,
    viewedError: viewed.isError && Boolean(current && !current.viewedAt),
    retryViewed,
    retryPending: retry.isPending,
    retryError: retry.error,
    retryTrial: () => retry.mutate(),
    adoptPending: adopt.isPending,
    adopt: () => adopt.mutate(),
    mutationError: retry.error?.message
      ?? revision.error
      ?? baseStrategy.error?.message
      ?? adopt.error?.message
      ?? null,
  };
}
