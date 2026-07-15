import type {
  ReadingSetupOperationKind,
  ReadingSetupOperationPayload,
  ReadingSetupOperationResponse,
  ReadingSetupOperationSource,
  ReadingSetupOperationStatus,
} from '@readtailor/contracts';

export type ReadingSetupOperationProjectionInput = {
  id: string;
  kind: ReadingSetupOperationKind;
  source: ReadingSetupOperationSource;
  baseStrategyDraftVersionId: string;
  baseTrialRevisionId: string | null;
  payload: ReadingSetupOperationPayload;
  status: ReadingSetupOperationStatus;
  attemptCount: number;
  resultStrategyDraftVersionId: string | null;
  resultTrialRevisionId: string | null;
  errorSummary: string | null;
};

export function projectReadingSetupOperation(
  operation: ReadingSetupOperationProjectionInput,
  leaseExpired = false,
): ReadingSetupOperationResponse | null {
  const common = {
    operationId: operation.id,
    operationAttempt: operation.attemptCount,
    baseDraftId: operation.baseStrategyDraftVersionId,
    canResume: operation.status === 'pending' || (
      operation.status === 'running' && leaseExpired
    ),
  };
  if (
    operation.kind === 'trial_selection'
    && operation.source === 'strategy_approve'
    && operation.payload.source === 'strategy_approve'
    && operation.baseTrialRevisionId === null
  ) {
    const identity = {
      ...common,
      kind: 'trial_selection' as const,
      source: 'strategy_approve' as const,
      baseTrialRevisionId: null,
    };
    if (operation.status === 'completed' && operation.resultTrialRevisionId) {
      return {
        ...identity,
        status: 'completed',
        resultDraftId: null,
        resultTrialRevisionId: operation.resultTrialRevisionId,
        errorSummary: null,
        recoverableInput: null,
      };
    }
    if (operation.status === 'failed' && operation.errorSummary) {
      return {
        ...identity,
        status: 'failed',
        resultDraftId: null,
        resultTrialRevisionId: null,
        errorSummary: operation.errorSummary,
        recoverableInput: null,
      };
    }
    if (operation.status === 'pending' || operation.status === 'running') {
      return {
        ...identity,
        status: operation.status,
        resultDraftId: null,
        resultTrialRevisionId: null,
        errorSummary: null,
        recoverableInput: null,
      };
    }
    return null;
  }

  if (
    operation.kind === 'strategy_revision'
    && operation.source === operation.payload.source
    && operation.payload.source !== 'strategy_approve'
    && (
      (operation.source === 'strategy_feedback' && operation.baseTrialRevisionId === null)
      || (operation.source === 'trial_feedback' && operation.baseTrialRevisionId !== null)
    )
  ) {
    const identity = operation.source === 'strategy_feedback'
      ? {
          ...common,
          kind: 'strategy_revision' as const,
          source: 'strategy_feedback' as const,
          baseTrialRevisionId: null,
        }
      : {
          ...common,
          kind: 'strategy_revision' as const,
          source: 'trial_feedback' as const,
          baseTrialRevisionId: operation.baseTrialRevisionId!,
        };
    if (operation.status === 'completed' && operation.resultStrategyDraftVersionId) {
      return {
        ...identity,
        status: 'completed',
        resultDraftId: operation.resultStrategyDraftVersionId,
        resultTrialRevisionId: null,
        errorSummary: null,
        recoverableInput: null,
      };
    }
    if (operation.status === 'failed' && operation.errorSummary) {
      return {
        ...identity,
        status: 'failed',
        resultDraftId: null,
        resultTrialRevisionId: null,
        errorSummary: operation.errorSummary,
        recoverableInput: { feedback: operation.payload.feedback },
      };
    }
    if (operation.status === 'pending' || operation.status === 'running') {
      return {
        ...identity,
        status: operation.status,
        resultDraftId: null,
        resultTrialRevisionId: null,
        errorSummary: null,
        recoverableInput: { feedback: operation.payload.feedback },
      };
    }
  }
  return null;
}
