import { describe, expect, it } from 'vitest';
import { buildTrialRetryPlan, UserBookError } from './user-books';

const draftId = '10000000-0000-0000-0000-000000000001';

function segment(ordinal: number) {
  return {
    id: `segment-${ordinal}`,
    ordinal,
    sectionId: `section-${ordinal}`,
    segment: ordinal,
    startBlockIndex: 1,
    startOffset: ordinal,
    endBlockIndex: 2,
    endOffset: ordinal + 10,
    selectionReason: `reason-${ordinal}`,
  };
}

function generation(ordinal: number) {
  return {
    id: `generation-${ordinal}`,
    generationScope: 'trial' as const,
    trialSegmentId: `segment-${ordinal}`,
    strategyDraftVersionId: draftId,
    sectionId: `section-${ordinal}`,
    segment: ordinal,
    maxAttempts: 3,
    modelConfigId: 'model-config',
    promptVersion: 'tailoring-content-1.0',
  };
}

describe('buildTrialRetryPlan', () => {
  it('pairs the exact persisted segment and generation rows in ordinal order', () => {
    const plan = buildTrialRetryPlan(
      draftId,
      [segment(3), segment(1), segment(2)],
      [generation(2), generation(3), generation(1)],
    );

    expect(plan.map(({ segment: item, generation: task }) => ({
      ordinal: item.ordinal,
      segmentId: item.id,
      generationId: task.id,
      range: [item.startBlockIndex, item.startOffset, item.endBlockIndex, item.endOffset],
    }))).toEqual([
      { ordinal: 1, segmentId: 'segment-1', generationId: 'generation-1', range: [1, 1, 2, 11] },
      { ordinal: 2, segmentId: 'segment-2', generationId: 'generation-2', range: [1, 2, 2, 12] },
      { ordinal: 3, segmentId: 'segment-3', generationId: 'generation-3', range: [1, 3, 2, 13] },
    ]);
  });

  it('rejects incomplete or cross-version retry sources', () => {
    expect(() => buildTrialRetryPlan(
      draftId,
      [segment(1), segment(2)],
      [generation(1), generation(2)],
    )).toThrow(UserBookError);

    expect(() => buildTrialRetryPlan(
      draftId,
      [segment(1), segment(2), segment(3)],
      [generation(1), generation(2), { ...generation(3), strategyDraftVersionId: 'other-draft' }],
    )).toThrow('失败试读版本的生成任务数据不完整');
  });
});
