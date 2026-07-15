import type {
  TrialRevisionStatus,
  TrialSegment,
  UserBookWorkflowStatus,
} from '@readtailor/contracts';

// SQL transition guards intentionally keep the numeric limit inline; this is the shared
// value projected to clients and used by pure permission checks.
export const ADJUSTMENT_LIMIT = 5;

export type ReadingSetupWorkflowPointers = {
  workflowStatus: UserBookWorkflowStatus;
  currentInterviewSessionId: string | null;
  currentStrategyDraftVersionId: string | null;
  currentTrialRevisionId: string | null;
  currentStrategyVersionId: string | null;
};

export type WorkflowPointerInvariantViolation =
  | 'interview_session_required'
  | 'strategy_draft_required'
  | 'trial_pointers_required'
  | 'formal_strategy_required';

export function workflowPointerInvariantViolation(
  state: ReadingSetupWorkflowPointers,
): WorkflowPointerInvariantViolation | null {
  if (state.workflowStatus === 'interviewing' && !state.currentInterviewSessionId) {
    return 'interview_session_required';
  }
  if (state.workflowStatus === 'strategy_review' && !state.currentStrategyDraftVersionId) {
    return 'strategy_draft_required';
  }
  if (
    ['trial_generating', 'trial_generation_failed', 'trial_review'].includes(state.workflowStatus)
    && (!state.currentStrategyDraftVersionId || !state.currentTrialRevisionId)
  ) {
    return 'trial_pointers_required';
  }
  if (state.workflowStatus === 'active_reading' && !state.currentStrategyVersionId) {
    return 'formal_strategy_required';
  }
  return null;
}

export function isCurrentStrategyDraftReview(
  state: Pick<ReadingSetupWorkflowPointers, 'workflowStatus' | 'currentStrategyDraftVersionId'>,
  draftId: string,
): boolean {
  return state.workflowStatus === 'strategy_review'
    && state.currentStrategyDraftVersionId === draftId;
}

export function isCurrentTrialReview(
  state: Pick<ReadingSetupWorkflowPointers, 'workflowStatus' | 'currentTrialRevisionId'>,
  trialRevisionId: string,
): boolean {
  return state.workflowStatus === 'trial_review'
    && state.currentTrialRevisionId === trialRevisionId;
}

export function canAdjustReadingSetup(
  isCurrent: boolean,
  adjustmentCount: number,
  adjustmentLimit = ADJUSTMENT_LIMIT,
): boolean {
  return isCurrent && adjustmentCount < adjustmentLimit;
}

export function canAdoptTrial(input: {
  isCurrent: boolean;
  revisionStatus: TrialRevisionStatus;
  segments: Pick<TrialSegment, 'status'>[];
}): boolean {
  // Viewing is not an adoption gate; publication and three generated fragments are sufficient.
  return input.isCurrent
    && input.revisionStatus === 'published'
    && input.segments.length === 3
    && input.segments.every((segment) => segment.status === 'ready');
}
