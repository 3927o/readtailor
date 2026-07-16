import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ReadingSetupOperationResponse } from '@readtailor/contracts';
import {
  getStrategy,
  streamStrategyFeedback,
  type StrategyRevisionClientEvent,
  type StrategySnapshot,
} from './api/strategy';
import { streamTrialFeedback } from './api/trial';
import {
  useReadingSetupOperation,
  type ReadingSetupOperationAdapter,
} from './operations/useReadingSetupOperation';
import {
  IDLE_STRATEGY_REVISION_STREAM,
  strategyRevisionStreamReducer,
  type StrategyRevisionSource,
  type StrategyRevisionStreamAction,
  type StrategyRevisionStreamState,
} from './strategyRevisionStreamState';
import { applyTransition } from './transitions';

interface RevisionInput {
  feedback: string;
}

interface RevisionCommand extends RevisionInput {
  source: StrategyRevisionSource;
  baseDraftId: string;
  baseTrialRevisionId: string | null;
  idempotencyKey: string;
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
  const adapter = useMemo<ReadingSetupOperationAdapter<
    StrategyRevisionStreamState,
    StrategyRevisionStreamAction,
    RevisionInput,
    RevisionCommand,
    StrategyRevisionClientEvent,
    StrategySnapshot,
    string
  >>(() => ({
    machine: {
      initialState: IDLE_STRATEGY_REVISION_STREAM,
      reduce: strategyRevisionStreamReducer,
      begin: (command) => ({
        type: 'begin',
        source: command.source,
        userBookId: options.userBookId,
        baseDraftId: command.baseDraftId,
        baseTrialRevisionId: command.baseTrialRevisionId,
      }),
      beginRecovery: () => ({
        type: 'begin',
        source: options.source,
        userBookId: options.userBookId,
        baseDraftId: options.baseDraftId,
        baseTrialRevisionId: options.baseTrialRevisionId,
      }),
      event: (event) => ({ type: 'event', event }),
      recover: (message) => ({ type: 'recover', ...(message ? { message } : {}) }),
      failed: (message) => ({ type: 'operation_failed', message }),
      complete: (strategy) => ({ type: 'complete', strategy }),
      reset: () => ({ type: 'reset' }),
      mode: (state) => state.mode,
      operationId: (state) => state.operationId,
      error: (state) => state.error,
    },
    commandKey: (input) => input.feedback,
    createCommand: (input, idempotencyKey) => ({
      ...input,
      source: options.source,
      baseDraftId: options.baseDraftId,
      baseTrialRevisionId: options.baseTrialRevisionId,
      idempotencyKey,
    }),
    stream: (command, onEvent, signal) => command.source === 'strategy_feedback'
      ? streamStrategyFeedback(
          options.userBookId,
          command.baseDraftId,
          command.feedback,
          command.idempotencyKey,
          { onEvent },
          signal,
        )
      : streamTrialFeedback(
          options.userBookId,
          command.baseTrialRevisionId!,
          command.feedback,
          command.idempotencyKey,
          { onEvent },
          signal,
        ),
    matchesOperation: (operation) => operation.kind === 'strategy_revision'
      && operation.source === options.source
      && operation.baseDraftId === options.baseDraftId
      && operation.baseTrialRevisionId === options.baseTrialRevisionId,
    resultFromEvent: (event, state) => event.type === 'revision_final'
      && state.finalStrategy?.draftId === event.strategy.draftId
      ? state.finalStrategy
      : null,
    isErrorEvent: (event) => event.type === 'error',
    loadCompleted: (operation: ReadingSetupOperationResponse) => operation.resultDraftId
      ? getStrategy(options.userBookId, operation.resultDraftId)
      : Promise.reject(new Error('修订 operation 缺少结果草稿。')),
    resultKey: (strategy) => strategy.draftId,
    applyCompleted: (strategy) => applyTransition(queryClient, options.userBookId, {
      type: 'strategy_committed',
      strategy,
    }),
    recoverableInput: (operation) => operation.recoverableInput?.feedback ?? null,
    failureMessage: (operation) => operation.errorSummary ?? '处理方式修订失败，请重试。',
    conflictMessage: '阅读准备状态已经变化，正在重新同步。',
  }), [
    options.baseDraftId,
    options.baseTrialRevisionId,
    options.source,
    options.userBookId,
    queryClient,
  ]);

  const operation = useReadingSetupOperation({
    userBookId: options.userBookId,
    baseKey: `${options.source}:${options.baseDraftId}:${options.baseTrialRevisionId ?? ''}`,
    enabled: options.enabled,
    adapter,
    ...(options.onCompleted ? { onCompleted: options.onCompleted } : {}),
    ...(options.onRecoverableFeedback
      ? { onRecoverableInput: options.onRecoverableFeedback }
      : {}),
  });

  return {
    ...operation,
    submit(feedback: string) {
      const normalized = feedback.trim();
      if (normalized) operation.submit({ feedback: normalized });
    },
  };
}
