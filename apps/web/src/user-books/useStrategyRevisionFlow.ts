import { useEffect, useReducer, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReadingSetupOperationResponse } from '@readtailor/contracts';
import {
  ApiError,
  getCurrentReadingSetupOperation,
  getReadingSetupOperation,
  getStrategy,
  resumeReadingSetupOperation,
  streamStrategyFeedback,
  streamTrialFeedback,
  type StrategyRevisionClientEvent,
  type StrategySnapshot,
} from './api';
import { userBookQueryKeys } from './queryKeys';
import {
  IDLE_STRATEGY_REVISION_STREAM,
  strategyRevisionStreamReducer,
  type StrategyRevisionSource,
} from './strategyRevisionStreamState';
import { applyTransition } from './transitions';

interface RevisionCommand {
  source: StrategyRevisionSource;
  baseDraftId: string;
  baseTrialRevisionId: string | null;
  feedback: string;
  idempotencyKey: string;
}

function matchesOperation(
  operation: ReadingSetupOperationResponse | null | undefined,
  source: StrategyRevisionSource,
  baseDraftId: string,
  baseTrialRevisionId: string | null,
): operation is ReadingSetupOperationResponse {
  return Boolean(
    operation
    && operation.kind === 'strategy_revision'
    && operation.source === source
    && operation.baseDraftId === baseDraftId
    && operation.baseTrialRevisionId === baseTrialRevisionId,
  );
}

export function useStrategyRevisionFlow(options: {
  userBookId: string;
  source: StrategyRevisionSource;
  baseDraftId: string;
  baseTrialRevisionId: string | null;
  enabled: boolean;
  onCompleted?(strategy: StrategySnapshot): void;
  onRecoverableFeedback?(feedback: string): void;
}) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(
    strategyRevisionStreamReducer,
    IDLE_STRATEGY_REVISION_STREAM,
  );
  const commandRef = useRef<RevisionCommand | null>(null);
  const resumedAttempts = useRef(new Set<string>());
  const completedDrafts = useRef(new Set<string>());

  const resync = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(options.userBookId) }),
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.strategies(options.userBookId) }),
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.trials(options.userBookId) }),
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.readingSetupOperations(options.userBookId) }),
    ]);
  };

  const complete = async (strategy: StrategySnapshot) => {
    if (completedDrafts.current.has(strategy.draftId)) return;
    completedDrafts.current.add(strategy.draftId);
    dispatch({ type: 'complete', strategy });
    commandRef.current = null;
    options.onCompleted?.(strategy);
    await applyTransition(queryClient, options.userBookId, {
      type: 'strategy_committed',
      strategy,
    });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.readingSetupOperations(options.userBookId) }),
    ]);
  };

  const handleEvent = (event: StrategyRevisionClientEvent) => {
    dispatch({ type: 'event', event });
    if (event.type === 'revision_final') {
      void complete(event.strategy);
    } else if (event.type === 'error') {
      void queryClient.invalidateQueries({
        queryKey: userBookQueryKeys.readingSetupOperations(options.userBookId),
      });
    }
  };

  const stream = useMutation<void, Error, RevisionCommand>({
    mutationFn: (command) => command.source === 'strategy_feedback'
      ? streamStrategyFeedback(
          options.userBookId,
          command.baseDraftId,
          command.feedback,
          command.idempotencyKey,
          { onEvent: handleEvent },
        )
      : streamTrialFeedback(
          options.userBookId,
          command.baseTrialRevisionId!,
          command.feedback,
          command.idempotencyKey,
          { onEvent: handleEvent },
        ),
    onMutate: (command) => {
      dispatch({
        type: 'begin',
        source: command.source,
        userBookId: options.userBookId,
        baseDraftId: command.baseDraftId,
        baseTrialRevisionId: command.baseTrialRevisionId,
      });
    },
    onError: (error) => {
      dispatch({
        type: 'recover',
        message: error instanceof ApiError && error.status === 409
          ? '阅读准备状态已经变化，正在重新同步。'
          : error.message,
      });
      void resync();
    },
  });

  const currentOperation = useQuery({
    queryKey: userBookQueryKeys.currentReadingSetupOperation(options.userBookId),
    queryFn: () => getCurrentReadingSetupOperation(options.userBookId),
    enabled: options.enabled && !state.operationId,
    refetchInterval: state.mode === 'recovering' ? 1000 : false,
  });
  const operationDetail = useQuery({
    queryKey: userBookQueryKeys.readingSetupOperation(
      options.userBookId,
      state.operationId ?? 'pending',
    ),
    queryFn: () => getReadingSetupOperation(options.userBookId, state.operationId!),
    enabled: options.enabled && state.mode === 'recovering' && Boolean(state.operationId),
    refetchInterval: (query) => ['pending', 'running'].includes(query.state.data?.status ?? '')
      ? 1000
      : false,
  });
  const observedOperation = state.operationId ? operationDetail.data : currentOperation.data;

  const resume = useMutation({
    mutationFn: (operationId: string) => resumeReadingSetupOperation(options.userBookId, operationId),
    onSuccess: (operation) => {
      queryClient.setQueryData(
        userBookQueryKeys.readingSetupOperation(options.userBookId, operation.operationId),
        operation,
      );
      void queryClient.invalidateQueries({
        queryKey: userBookQueryKeys.readingSetupOperations(options.userBookId),
      });
    },
    onError: () => void resync(),
  });

  useEffect(() => {
    if (
      state.mode !== 'idle'
      && state.baseDraftId
      && (
        state.baseDraftId !== options.baseDraftId
        || state.baseTrialRevisionId !== options.baseTrialRevisionId
      )
    ) {
      commandRef.current = null;
      dispatch({ type: 'reset' });
    }
  }, [
    options.baseDraftId,
    options.baseTrialRevisionId,
    state.baseDraftId,
    state.baseTrialRevisionId,
    state.mode,
  ]);

  useEffect(() => {
    const operation = currentOperation.data;
    if (
      state.mode === 'idle'
      && matchesOperation(
        operation,
        options.source,
        options.baseDraftId,
        options.baseTrialRevisionId,
      )
      && (operation.status === 'pending' || operation.status === 'running')
    ) {
      dispatch({
        type: 'begin',
        source: options.source,
        userBookId: options.userBookId,
        baseDraftId: options.baseDraftId,
        baseTrialRevisionId: options.baseTrialRevisionId,
      });
      dispatch({ type: 'recover' });
      if (operation.recoverableInput?.feedback) {
        options.onRecoverableFeedback?.(operation.recoverableInput.feedback);
      }
    }
  }, [
    currentOperation.data,
    options.baseDraftId,
    options.baseTrialRevisionId,
    options.source,
    options.userBookId,
    state.mode,
  ]);

  useEffect(() => {
    const operation = observedOperation;
    if (
      state.mode !== 'recovering'
      || !matchesOperation(
        operation,
        options.source,
        options.baseDraftId,
        options.baseTrialRevisionId,
      )
    ) return;
    if (operation.recoverableInput?.feedback) {
      options.onRecoverableFeedback?.(operation.recoverableInput.feedback);
    }
    if (operation.status === 'completed' && operation.resultDraftId) {
      void getStrategy(options.userBookId, operation.resultDraftId).then(complete).catch(() => {
        void resync();
      });
      return;
    }
    if (operation.status === 'failed') {
      commandRef.current = null;
      dispatch({
        type: 'operation_failed',
        message: operation.errorSummary ?? '处理方式修订失败，请重试。',
      });
      return;
    }
    if (operation.canResume) {
      const attemptKey = `${operation.operationId}:${operation.operationAttempt}`;
      if (!resumedAttempts.current.has(attemptKey)) {
        resumedAttempts.current.add(attemptKey);
        resume.mutate(operation.operationId);
      }
    }
  }, [
    observedOperation,
    options.baseDraftId,
    options.baseTrialRevisionId,
    options.source,
    options.userBookId,
    state.mode,
  ]);

  const submit = (feedback: string) => {
    const normalized = feedback.trim();
    if (!normalized || stream.isPending || state.mode === 'recovering') return;
    const previous = commandRef.current;
    const command = previous
      && previous.source === options.source
      && previous.baseDraftId === options.baseDraftId
      && previous.baseTrialRevisionId === options.baseTrialRevisionId
      && previous.feedback === normalized
      ? previous
      : {
          source: options.source,
          baseDraftId: options.baseDraftId,
          baseTrialRevisionId: options.baseTrialRevisionId,
          feedback: normalized,
          idempotencyKey: crypto.randomUUID(),
        };
    commandRef.current = command;
    stream.mutate(command);
  };

  return {
    state,
    submit,
    pending: stream.isPending || resume.isPending || state.mode === 'recovering',
    active: state.mode === 'streaming' || state.mode === 'recovering' || state.mode === 'completed',
    error: state.mode === 'failed' ? state.error : null,
  };
}
