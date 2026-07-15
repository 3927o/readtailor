import type {
  GenerationResult,
  NodeGenerationStatus,
  TrialReviewResponse,
  TrialRevisionStatus,
  TrialSegment,
  TrialSegmentStatus,
  UserBookWorkflowStatus,
} from '@readtailor/contracts';
import {
  canAdjustReadingSetup,
  canAdoptTrial,
  isCurrentTrialReview,
} from '../domain/reading-setup-state';

export type TrialSegmentProjectionInput = {
  id: string;
  ordinal: number;
  sectionId: string;
  segment: number;
  startBlockIndex: number;
  startOffset: number;
  endBlockIndex: number;
  endOffset: number;
  chapterPath: string[];
  originalHtml: string;
  selectionReason: string;
  viewedAt: Date | null;
  segmentStatus: TrialSegmentStatus;
  generationStatus: NodeGenerationStatus | null;
  generationResult: GenerationResult | null;
};

export function projectTrialSegment(input: TrialSegmentProjectionInput): TrialSegment {
  const common = {
    id: input.id,
    ordinal: input.ordinal,
    sectionId: input.sectionId,
    segment: input.segment,
    range: {
      start: { blockIndex: input.startBlockIndex, offset: input.startOffset },
      end: { blockIndex: input.endBlockIndex, offset: input.endOffset },
    },
    chapterPath: input.chapterPath,
    originalHtml: input.originalHtml,
    selectionReason: input.selectionReason,
    viewedAt: input.viewedAt?.toISOString() ?? null,
  };
  if (
    input.segmentStatus === 'ready'
    && input.generationStatus === 'ready'
    && input.generationResult
  ) {
    return { ...common, status: 'ready', result: input.generationResult };
  }
  if (input.segmentStatus === 'generating') {
    return { ...common, status: 'generating', result: null };
  }
  if (input.segmentStatus === 'failed' || input.segmentStatus === 'ready') {
    return { ...common, status: 'failed', result: null };
  }
  return { ...common, status: 'pending', result: null };
}

export type TrialReviewProjectionInput = {
  userBookId: string;
  workflowStatus: UserBookWorkflowStatus;
  currentTrialRevisionId: string | null;
  trialRevisionId: string;
  revision: number;
  status: TrialRevisionStatus;
  strategyDraftVersionId: string;
  segments: TrialSegment[];
  adjustmentCount: number;
  adjustmentLimit: number;
};

export function projectTrialReview(input: TrialReviewProjectionInput): TrialReviewResponse {
  const isCurrent = isCurrentTrialReview(input, input.trialRevisionId);
  return {
    userBookId: input.userBookId,
    workflowStatus: input.workflowStatus,
    trialRevisionId: input.trialRevisionId,
    revision: input.revision,
    status: input.status,
    strategyDraftVersionId: input.strategyDraftVersionId,
    segments: input.segments,
    adjustmentCount: input.adjustmentCount,
    adjustmentLimit: input.adjustmentLimit,
    canAdjust: canAdjustReadingSetup(
      isCurrent,
      input.adjustmentCount,
      input.adjustmentLimit,
    ),
    canAdopt: canAdoptTrial({
      isCurrent,
      revisionStatus: input.status,
      segments: input.segments,
    }),
  };
}
