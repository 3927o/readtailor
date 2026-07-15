import type {
  StrategyReviewResponse,
  UserBookWorkflowStatus,
} from '@readtailor/contracts';
import {
  canAdjustReadingSetup,
  isCurrentStrategyDraftReview,
} from '../domain/reading-setup-state';

export type StrategyReviewProjectionInput = {
  userBookId: string;
  workflowStatus: UserBookWorkflowStatus;
  currentStrategyDraftVersionId: string | null;
  adjustmentCount: number;
  adjustmentLimit: number;
  draft: {
    id: string;
    version: number;
    status: StrategyReviewResponse['draft']['status'];
    readingBriefing: StrategyReviewResponse['draft']['readingBriefing'];
    userFacingSummary: string;
    strategy: StrategyReviewResponse['draft']['strategy'];
    createdAt: Date;
    approvedForTrialAt: Date | null;
  };
  trialCandidatePreviews: StrategyReviewResponse['trialCandidatePreviews'];
};

export function projectStrategyReview(
  input: StrategyReviewProjectionInput,
): StrategyReviewResponse {
  const isCurrent = isCurrentStrategyDraftReview(input, input.draft.id);
  return {
    userBookId: input.userBookId,
    workflowStatus: input.workflowStatus,
    draft: {
      id: input.draft.id,
      version: input.draft.version,
      status: input.draft.status,
      readingBriefing: input.draft.readingBriefing,
      userFacingSummary: input.draft.userFacingSummary,
      strategy: input.draft.strategy,
      createdAt: input.draft.createdAt.toISOString(),
      approvedForTrialAt: input.draft.approvedForTrialAt?.toISOString() ?? null,
    },
    trialCandidatePreviews: input.trialCandidatePreviews,
    adjustmentCount: input.adjustmentCount,
    adjustmentLimit: input.adjustmentLimit,
    canAdjust: canAdjustReadingSetup(
      isCurrent,
      input.adjustmentCount,
      input.adjustmentLimit,
    ),
  };
}
