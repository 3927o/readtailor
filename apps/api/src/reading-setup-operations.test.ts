import { describe, expect, it } from 'vitest';
import { readingSetupOperationRequestHash } from './user-books';

const DRAFT_ID = '55555555-6666-4777-8888-999999999999';

describe('readingSetupOperationRequestHash', () => {
  it('is stable across object key order', () => {
    const left = readingSetupOperationRequestHash({
      source: 'strategy_feedback',
      baseStrategyDraftVersionId: DRAFT_ID,
      baseTrialRevisionId: null,
      payload: {
        source: 'strategy_feedback',
        strategyDraftVersionId: DRAFT_ID,
        feedback: 'make it clearer',
      },
    });
    const right = readingSetupOperationRequestHash({
      payload: {
        feedback: 'make it clearer',
        strategyDraftVersionId: DRAFT_ID,
        source: 'strategy_feedback',
      },
      baseTrialRevisionId: null,
      baseStrategyDraftVersionId: DRAFT_ID,
      source: 'strategy_feedback',
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
  });

  it('binds the key to source, base pointers and feedback', () => {
    const base = {
      source: 'strategy_feedback' as const,
      baseStrategyDraftVersionId: DRAFT_ID,
      baseTrialRevisionId: null,
      payload: {
        source: 'strategy_feedback' as const,
        strategyDraftVersionId: DRAFT_ID,
        feedback: 'make it clearer',
      },
    };
    const original = readingSetupOperationRequestHash(base);

    expect(readingSetupOperationRequestHash({
      ...base,
      payload: { ...base.payload, feedback: 'make it shorter' },
    })).not.toBe(original);
    expect(readingSetupOperationRequestHash({
      ...base,
      baseStrategyDraftVersionId: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
    })).not.toBe(original);
  });
});
