import { useEffect, useReducer, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReadingSetupOperationResponse } from '@readtailor/contracts';
import {
  ApiError,
  getCurrentReadingSetupOperation,
  getReadingSetupOperation,
  getTrial,
  resumeReadingSetupOperation,
  streamApproveStrategyForTrial,
  type TrialSelectionClientEvent,
  type TrialSnapshot,
} from './api';
import { userBookQueryKeys } from './queryKeys';
import {
  IDLE_TRIAL_SELECTION_STREAM,
  trialSelectionStreamReducer,
  type TrialOrdinal,
  type TrialSelectionStreamAction,
} from './trialSelectionStreamState';
import { applyTransition } from './transitions';

interface TrialSelectionCommand {
  draftId: string;
  idempotencyKey: string;
}

function matchesOperation(
  operation: ReadingSetupOperationResponse | null | undefined,
  draftId: string,
): operation is ReadingSetupOperationResponse {
  return Boolean(
    operation
    && operation.kind === 'trial_selection'
    && operation.source === 'strategy_approve'
    && operation.baseDraftId === draftId
    && operation.baseTrialRevisionId === null,
  );
}

export function useTrialSelectionFlow(options: {
  userBookId: string;
  draftId: string;
  enabled: boolean;
  onCompleted?(trial: TrialSnapshot): void;
}) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(
    trialSelectionStreamReducer,
    IDLE_TRIAL_SELECTION_STREAM,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const commandRef = useRef<TrialSelectionCommand | null>(null);
  const resumedAttempts = useRef(new Set<string>());
  const completedRevisions = useRef(new Set<string>());

  const dispatchTracked = (action: TrialSelectionStreamAction) => {
    stateRef.current = trialSelectionStreamReducer(stateRef.current, action);
    dispatch(action);
    return stateRef.current;
  };

  const resync = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(options.userBookId) }),
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.strategies(options.userBookId) }),
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.trials(options.userBookId) }),
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.readingSetupOperations(options.userBookId) }),
    ]);
  };

  const complete = async (trial: TrialSnapshot) => {
    if (trial.draftId !== options.draftId || completedRevisions.current.has(trial.revisionId)) return;
    completedRevisions.current.add(trial.revisionId);
    dispatchTracked({ type: 'complete', trial });
    commandRef.current = null;
    options.onCompleted?.(trial);
    await applyTransition(queryClient, options.userBookId, { type: 'trial_committed', trial });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.readingSetupOperations(options.userBookId) }),
    ]);
  };

  const handleEvent = (event: TrialSelectionClientEvent) => {
    const next = dispatchTracked({ type: 'event', event });
    if (
      event.type === 'trial_created'
      && next.mode === 'completed'
      && next.finalTrial?.revisionId === event.trial.revisionId
    ) {
      void complete(event.trial);
    } else if (event.type === 'error') {
      void queryClient.invalidateQueries({
        queryKey: userBookQueryKeys.readingSetupOperations(options.userBookId),
      });
    }
  };

  const stream = useMutation<void, Error, TrialSelectionCommand>({
    mutationFn: (command) => streamApproveStrategyForTrial(
      options.userBookId,
      command.draftId,
      command.idempotencyKey,
      { onEvent: handleEvent },
    ),
    onMutate: (command) => {
      dispatchTracked({
        type: 'begin',
        userBookId: options.userBookId,
        draftId: command.draftId,
      });
    },
    onError: (error) => {
      dispatchTracked({
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
    if (state.mode !== 'idle' && state.draftId && state.draftId !== options.draftId) {
      commandRef.current = null;
      dispatchTracked({ type: 'reset' });
    }
  }, [options.draftId, state.draftId, state.mode]);

  useEffect(() => {
    const operation = currentOperation.data;
    if (
      state.mode === 'idle'
      && matchesOperation(operation, options.draftId)
    ) {
      dispatchTracked({
        type: 'begin',
        userBookId: options.userBookId,
        draftId: options.draftId,
      });
      dispatchTracked({ type: 'recover' });
    }
  }, [currentOperation.data, options.draftId, options.userBookId, state.mode]);

  useEffect(() => {
    const operation = observedOperation;
    if (
      state.mode !== 'recovering'
      || !matchesOperation(operation, options.draftId)
    ) return;
    if (operation.status === 'completed' && operation.resultTrialRevisionId) {
      void getTrial(options.userBookId, operation.resultTrialRevisionId).then(complete).catch(() => {
        void resync();
      });
      return;
    }
    if (operation.status === 'failed') {
      commandRef.current = null;
      dispatchTracked({
        type: 'operation_failed',
        message: operation.errorSummary ?? '试读片段选择失败，请重试。',
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
  }, [observedOperation, options.draftId, options.userBookId, state.mode]);

  const submit = () => {
    if (!options.draftId || stream.isPending || state.mode === 'recovering') return;
    const previous = commandRef.current;
    const command = previous?.draftId === options.draftId
      ? previous
      : { draftId: options.draftId, idempotencyKey: crypto.randomUUID() };
    commandRef.current = command;
    stream.mutate(command);
  };

  const selectOrdinal = (ordinal: TrialOrdinal) => {
    dispatchTracked({ type: 'select', ordinal });
  };

  return {
    state,
    submit,
    selectOrdinal,
    pending: stream.isPending || resume.isPending || state.mode === 'recovering',
    active: state.mode === 'selecting' || state.mode === 'recovering' || state.mode === 'completed',
    error: state.mode === 'failed' ? state.error : null,
  };
}
