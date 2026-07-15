import { describe, expect, it } from 'vitest';
import {
  projectStrategyReview,
  type StrategyReviewProjectionInput,
} from './strategy-review';
import {
  projectTrialReview,
  projectTrialSegment,
} from './trial-review';

const strategyInput: StrategyReviewProjectionInput = {
  userBookId: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
  workflowStatus: 'strategy_review',
  currentStrategyDraftVersionId: '55555555-6666-4777-8888-999999999999',
  adjustmentCount: 1,
  adjustmentLimit: 5,
  draft: {
    id: '55555555-6666-4777-8888-999999999999',
    version: 2,
    status: 'draft',
    readingBriefing: {
      bookIdentity: 'identity',
      arc: 'arc',
      assumedKnowledge: 'knowledge',
      readingAdvice: 'advice',
    },
    userFacingSummary: 'summary',
    strategy: {
      goals: ['goal'],
      expressionPrinciples: ['plain'],
      guide: { enabled: true, objectives: ['orient'] },
      annotations: { enabled: true, focuses: ['terms'], exclusions: [] },
      afterReading: { enabled: true, objectives: ['recap'] },
      trialCandidates: [1, 2, 3].map((segment) => ({
        sectionId: 'chapter-1',
        segment,
        reason: `reason-${segment}`,
      })),
    },
    createdAt: new Date('2026-07-14T00:00:00.000Z'),
    approvedForTrialAt: null,
  },
  trialCandidatePreviews: [1, 2, 3].map((segment) => ({
    ordinal: segment,
    sectionId: 'chapter-1',
    segment,
    chapterPath: ['Chapter 1'],
    reason: `reason-${segment}`,
  })),
};

function readySegment(ordinal: number) {
  return projectTrialSegment({
    id: `segment-${ordinal}`,
    ordinal,
    sectionId: 'chapter-1',
    segment: ordinal,
    startBlockIndex: 1,
    startOffset: 0,
    endBlockIndex: 1,
    endOffset: 5,
    chapterPath: ['Chapter 1'],
    originalHtml: '<p>text</p>',
    selectionReason: `reason-${ordinal}`,
    viewedAt: null,
    segmentStatus: 'ready',
    generationStatus: 'ready',
    generationResult: { guide: null, annotations: [], afterReading: null },
  });
}

describe('review projections', () => {
  it('serializes strategy dates and derives canAdjust from canonical pointers', () => {
    expect(projectStrategyReview(strategyInput)).toMatchObject({
      draft: {
        createdAt: '2026-07-14T00:00:00.000Z',
        approvedForTrialAt: null,
      },
      canAdjust: true,
    });
    expect(projectStrategyReview({
      ...strategyInput,
      currentStrategyDraftVersionId: 'older-draft',
    }).canAdjust).toBe(false);
  });

  it('preserves the trial segment status mapping', () => {
    expect(readySegment(1).status).toBe('ready');
    expect(projectTrialSegment({
      id: 'segment-2',
      ordinal: 2,
      sectionId: 'chapter-1',
      segment: 2,
      startBlockIndex: 1,
      startOffset: 0,
      endBlockIndex: 1,
      endOffset: 5,
      chapterPath: ['Chapter 1'],
      originalHtml: '<p>text</p>',
      selectionReason: 'reason',
      viewedAt: new Date('2026-07-15T00:00:00.000Z'),
      segmentStatus: 'ready',
      generationStatus: 'failed',
      generationResult: null,
    })).toMatchObject({
      status: 'failed',
      result: null,
      viewedAt: '2026-07-15T00:00:00.000Z',
    });
  });

  it('derives trial adjustment and adoption permissions', () => {
    const segments = [readySegment(1), readySegment(2), readySegment(3)];
    const review = projectTrialReview({
      userBookId: strategyInput.userBookId,
      workflowStatus: 'trial_review',
      currentTrialRevisionId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
      trialRevisionId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
      revision: 1,
      status: 'published',
      strategyDraftVersionId: strategyInput.draft.id,
      segments,
      adjustmentCount: 1,
      adjustmentLimit: 5,
    });

    expect(review).toMatchObject({ canAdjust: true, canAdopt: true });
    expect(projectTrialReview({
      ...review,
      currentTrialRevisionId: 'newer-trial',
      adjustmentLimit: 5,
    }).canAdopt).toBe(false);
  });
});
