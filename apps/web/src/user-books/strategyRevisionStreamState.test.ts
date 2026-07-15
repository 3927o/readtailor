import { describe, expect, it } from 'vitest';
import type { StrategyRevisionClientEvent, StrategySnapshot } from './api';
import {
  IDLE_STRATEGY_REVISION_STREAM,
  strategyRevisionStreamReducer,
} from './strategyRevisionStreamState';

const userBookId = '10000000-0000-0000-0000-000000000001';
const operationId = '10000000-0000-0000-0000-000000000002';
const draftId = '10000000-0000-0000-0000-000000000003';

function event<T extends Omit<StrategyRevisionClientEvent, 'userBookId' | 'operationId' | 'operationAttempt' | 'sequence'>>(
  sequence: number,
  value: T,
  operationAttempt = 1,
): StrategyRevisionClientEvent {
  return {
    userBookId,
    operationId,
    operationAttempt,
    sequence,
    ...value,
  } as unknown as StrategyRevisionClientEvent;
}

const node = {
  ordinal: 1,
  sectionId: 'chapter-1',
  segment: 1,
  chapterPath: ['第一章'],
  reason: '进入门槛',
};

const finalStrategy: StrategySnapshot = {
  draftId: '10000000-0000-0000-0000-000000000004',
  draftVersion: 2,
  readingBriefing: {
    bookIdentity: '定位',
    arc: '脉络',
    assumedKnowledge: '前提',
    readingAdvice: '读法',
  },
  userFacingSummary: '最终方式',
  trialCandidatePreviews: [node, { ...node, ordinal: 2 }, { ...node, ordinal: 3 }],
  adjustmentCount: 1,
  adjustmentLimit: 5,
  canAdjust: true,
};

function begin() {
  return strategyRevisionStreamReducer(IDLE_STRATEGY_REVISION_STREAM, {
    type: 'begin',
    source: 'strategy_feedback',
    userBookId,
    baseDraftId: draftId,
    baseTrialRevisionId: null,
  });
}

describe('strategy revision stream reducer', () => {
  it('fences sequence, attempt and epoch before accepting provisional deltas', () => {
    let state = begin();
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(1, { type: 'speculative_reset', phase: 'strategy_review', speculativeEpoch: 1 }) });
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(2, { type: 'revision_started', source: 'strategy_feedback', baseDraftId: draftId, baseTrialRevisionId: null, speculativeEpoch: 1 }) });
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(3, { type: 'strategy_delta', chars: '第一段', speculativeEpoch: 1 }) });
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(3, { type: 'strategy_delta', chars: '重复', speculativeEpoch: 1 }) });
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(4, { type: 'strategy_delta', chars: '旧 attempt', speculativeEpoch: 1 }, 0) });
    expect(state.strategySummary).toBe('第一段');

    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(1, { type: 'speculative_reset', phase: 'strategy_review', speculativeEpoch: 2 }, 2) });
    expect(state.strategySummary).toBe('');
    expect(state.operationAttempt).toBe(2);
  });

  it('requires matching revision identity and lets final overwrite provisional content', () => {
    let state = begin();
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(1, { type: 'revision_started', source: 'trial_feedback', baseDraftId: draftId, baseTrialRevisionId: null, speculativeEpoch: 1 }) });
    expect(state.mode).toBe('recovering');

    state = begin();
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(1, { type: 'revision_started', source: 'strategy_feedback', baseDraftId: draftId, baseTrialRevisionId: null, speculativeEpoch: 1 }) });
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(2, { type: 'strategy_delta', chars: '临时方式', speculativeEpoch: 1 }) });
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(3, { type: 'reading_node_added', node, speculativeEpoch: 1 }) });
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(4, { type: 'revision_final', strategy: finalStrategy }) });
    expect(state.mode).toBe('completed');
    expect(state.strategySummary).toBe('最终方式');
    expect(state.nodes).toEqual(finalStrategy.trialCandidatePreviews);
  });

  it('keeps provisional content while recovering and clears it only after operation failed', () => {
    let state = begin();
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(1, { type: 'revision_started', source: 'strategy_feedback', baseDraftId: draftId, baseTrialRevisionId: null, speculativeEpoch: 1 }) });
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(2, { type: 'strategy_delta', chars: '临时方式', speculativeEpoch: 1 }) });
    state = strategyRevisionStreamReducer(state, { type: 'event', event: event(3, { type: 'error', code: 'lease_lost', message: '恢复中' }) });
    expect(state.mode).toBe('recovering');
    expect(state.strategySummary).toBe('临时方式');

    state = strategyRevisionStreamReducer(state, { type: 'operation_failed', message: '最终失败' });
    expect(state.mode).toBe('failed');
    expect(state.strategySummary).toBe('');
  });
});
