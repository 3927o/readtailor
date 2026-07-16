import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReadingSetupOperationResponse } from '@readtailor/contracts';
import {
  getTrial,
  streamApproveStrategyForTrial,
  type TrialSelectionClientEvent,
  type TrialSnapshot,
} from './api/trial';
import {
  useReadingSetupOperation,
  type ReadingSetupOperationAdapter,
} from './operations/useReadingSetupOperation';
import {
  IDLE_TRIAL_SELECTION_STREAM,
  trialSelectionStreamReducer,
  type TrialOrdinal,
  type TrialSelectionStreamAction,
  type TrialSelectionStreamState,
} from './trialSelectionStreamState';
import { applyTransition } from './transitions';

type TrialSelectionInput = Record<string, never>;

interface TrialSelectionCommand {
  draftId: string;
  idempotencyKey: string;
}

export function useTrialSelectionFlow(options: {
  userBookId: string;
  draftId: string;
  enabled: boolean;
  onCompleted?(trial: TrialSnapshot): void;
}) {
  const queryClient = useQueryClient();
  const adapter = useMemo<ReadingSetupOperationAdapter<
    TrialSelectionStreamState,
    TrialSelectionStreamAction,
    TrialSelectionInput,
    TrialSelectionCommand,
    TrialSelectionClientEvent,
    TrialSnapshot,
    never
  >>(() => ({
    machine: {
      initialState: IDLE_TRIAL_SELECTION_STREAM,
      reduce: trialSelectionStreamReducer,
      begin: (command) => ({
        type: 'begin',
        userBookId: options.userBookId,
        draftId: command.draftId,
      }),
      beginRecovery: () => ({
        type: 'begin',
        userBookId: options.userBookId,
        draftId: options.draftId,
      }),
      event: (event) => ({ type: 'event', event }),
      recover: (message) => ({ type: 'recover', ...(message ? { message } : {}) }),
      failed: (message) => ({ type: 'operation_failed', message }),
      complete: (trial) => ({ type: 'complete', trial }),
      reset: () => ({ type: 'reset' }),
      mode: (state) => state.mode,
      operationId: (state) => state.operationId,
      error: (state) => state.error,
    },
    commandKey: () => options.draftId,
    createCommand: (_input, idempotencyKey) => ({ draftId: options.draftId, idempotencyKey }),
    stream: (command, onEvent, signal) => streamApproveStrategyForTrial(
      options.userBookId,
      command.draftId,
      command.idempotencyKey,
      { onEvent },
      signal,
    ),
    matchesOperation: (operation) => operation.kind === 'trial_selection'
      && operation.source === 'strategy_approve'
      && operation.baseDraftId === options.draftId
      && operation.baseTrialRevisionId === null,
    resultFromEvent: (event, state) => event.type === 'trial_created'
      && state.finalTrial?.revisionId === event.trial.revisionId
      ? state.finalTrial
      : null,
    isErrorEvent: (event) => event.type === 'error',
    loadCompleted: (operation: ReadingSetupOperationResponse) => operation.resultTrialRevisionId
      ? getTrial(options.userBookId, operation.resultTrialRevisionId)
      : Promise.reject(new Error('试读选择 operation 缺少结果 revision。')),
    resultKey: (trial) => trial.revisionId,
    applyCompleted: (trial) => applyTransition(queryClient, options.userBookId, {
      type: 'trial_committed',
      trial,
    }),
    recoverableInput: () => null,
    failureMessage: (operation) => operation.errorSummary ?? '试读片段选择失败，请重试。',
    conflictMessage: '阅读准备状态已经变化，正在重新同步。',
  }), [options.draftId, options.userBookId, queryClient]);

  const operation = useReadingSetupOperation({
    userBookId: options.userBookId,
    baseKey: options.draftId,
    enabled: options.enabled,
    adapter,
    ...(options.onCompleted ? { onCompleted: options.onCompleted } : {}),
  });

  return {
    ...operation,
    submit: () => operation.submit({}),
    selectOrdinal: (ordinal: TrialOrdinal) => operation.dispatch({ type: 'select', ordinal }),
  };
}
