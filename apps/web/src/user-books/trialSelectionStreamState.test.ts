import { describe, expect, it } from 'vitest';
import type { TrialSelectionClientEvent, TrialSnapshot } from './api';
import {
  IDLE_TRIAL_SELECTION_STREAM,
  trialSelectionStreamReducer,
} from './trialSelectionStreamState';

const userBookId = '10000000-0000-0000-0000-000000000001';
const operationId = '10000000-0000-0000-0000-000000000002';
const draftId = '10000000-0000-0000-0000-000000000003';

function event<T extends Omit<TrialSelectionClientEvent, 'userBookId' | 'operationId' | 'operationAttempt' | 'sequence'>>(
  sequence: number,
  value: T,
  operationAttempt = 1,
): TrialSelectionClientEvent {
  return {
    userBookId,
    operationId,
    operationAttempt,
    sequence,
    ...value,
  } as unknown as TrialSelectionClientEvent;
}

function sample(ordinal: 1 | 2 | 3) {
  const tags = ['threshold', 'typical', 'hardest'] as const;
  return {
    ordinal,
    tag: tags[ordinal - 1],
    sectionId: `section-${ordinal}`,
    segment: ordinal,
    range: {
      start: { blockIndex: 1, offset: 0 },
      end: { blockIndex: 1, offset: 10 },
    },
    chapterPath: [`章节 ${ordinal}`],
    originalHtml: `<p>原文 ${ordinal}</p>`,
    selectionReason: `原因 ${ordinal}`,
  };
}

const finalTrial: TrialSnapshot = {
  revisionId: '10000000-0000-0000-0000-000000000004',
  revision: 1,
  draftId,
  status: 'generating',
  progress: { completed: 0, total: 3 },
  adjustmentCount: 0,
  adjustmentLimit: 5,
  canAdjust: false,
  canAdopt: false,
  samples: [1, 2, 3].map((ordinal) => ({
    id: `segment-${ordinal}`,
    ordinal,
    status: 'pending' as const,
    sectionId: `section-${ordinal}`,
    segment: ordinal,
    chapterPath: [`章节 ${ordinal}`],
    selectionReason: `原因 ${ordinal}`,
    originalHtml: `<p>原文 ${ordinal}</p>`,
    viewedAt: null,
    tailoredContent: null,
  })),
  errorSummary: null,
};

function begin() {
  return trialSelectionStreamReducer(IDLE_TRIAL_SELECTION_STREAM, {
    type: 'begin',
    userBookId,
    draftId,
  });
}

function startSelection() {
  return event(1, {
    type: 'selection_started',
    speculativeEpoch: 1,
    draftId,
    slots: [
      { ordinal: 1, tag: 'threshold' },
      { ordinal: 2, tag: 'typical' },
      { ordinal: 3, tag: 'hardest' },
    ],
  });
}

describe('trial selection stream reducer', () => {
  it('keeps three fixed slots and fills fragments by ordinal without changing the active slot', () => {
    let state = begin();
    expect(state.slots.map((slot) => slot.ordinal)).toEqual([1, 2, 3]);
    state = trialSelectionStreamReducer(state, { type: 'event', event: startSelection() });
    state = trialSelectionStreamReducer(state, {
      type: 'event',
      event: event(2, { type: 'fragment_selected', speculativeEpoch: 1, draftId, sample: sample(2) }),
    });
    expect(state.slots.map((slot) => slot.sample?.ordinal ?? null)).toEqual([null, 2, null]);
    expect(state.activeOrdinal).toBe(1);
  });

  it('fences duplicate sequence, stale attempts and speculative epochs', () => {
    let state = begin();
    state = trialSelectionStreamReducer(state, { type: 'event', event: startSelection() });
    state = trialSelectionStreamReducer(state, {
      type: 'event',
      event: event(2, { type: 'fragment_selected', speculativeEpoch: 1, draftId, sample: sample(1) }),
    });
    state = trialSelectionStreamReducer(state, {
      type: 'event',
      event: event(2, { type: 'fragment_selected', speculativeEpoch: 1, draftId, sample: sample(2) }),
    });
    state = trialSelectionStreamReducer(state, {
      type: 'event',
      event: event(3, { type: 'fragment_selected', speculativeEpoch: 1, draftId, sample: sample(3) }, 0),
    });
    expect(state.slots.map((slot) => slot.sample?.ordinal ?? null)).toEqual([1, null, null]);

    state = trialSelectionStreamReducer(state, {
      type: 'event',
      event: event(1, { type: 'speculative_reset', phase: 'select_trial', speculativeEpoch: 2 }, 2),
    });
    expect(state.operationAttempt).toBe(2);
    expect(state.slots.every((slot) => slot.sample === null)).toBe(true);
  });

  it('ignores mismatched operation, draft and slot tag identities', () => {
    let state = begin();
    state = trialSelectionStreamReducer(state, { type: 'event', event: startSelection() });
    state = trialSelectionStreamReducer(state, {
      type: 'event',
      event: { ...event(2, { type: 'fragment_selected', speculativeEpoch: 1, draftId, sample: sample(1) }), operationId: '20000000-0000-0000-0000-000000000002' },
    });
    state = trialSelectionStreamReducer(state, {
      type: 'event',
      event: event(3, { type: 'fragment_selected', speculativeEpoch: 1, draftId: '20000000-0000-0000-0000-000000000003', sample: sample(1) }),
    });
    state = trialSelectionStreamReducer(state, {
      type: 'event',
      event: event(4, {
        type: 'fragment_selected',
        speculativeEpoch: 1,
        draftId,
        sample: { ...sample(1), tag: 'typical' },
      } as unknown as Omit<TrialSelectionClientEvent, 'userBookId' | 'operationId' | 'operationAttempt' | 'sequence'>),
    });
    expect(state.slots.every((slot) => slot.sample === null)).toBe(true);
  });

  it('preserves provisional samples while recovering and clears them only after operation failure', () => {
    let state = begin();
    state = trialSelectionStreamReducer(state, { type: 'event', event: startSelection() });
    state = trialSelectionStreamReducer(state, {
      type: 'event',
      event: event(2, { type: 'fragment_selected', speculativeEpoch: 1, draftId, sample: sample(1) }),
    });
    state = trialSelectionStreamReducer(state, {
      type: 'event',
      event: event(3, { type: 'error', code: 'lease_lost', message: '正在恢复' }),
    });
    expect(state.mode).toBe('recovering');
    expect(state.slots[0].sample?.ordinal).toBe(1);

    state = trialSelectionStreamReducer(state, { type: 'operation_failed', message: '最终失败' });
    expect(state.mode).toBe('failed');
    expect(state.slots.every((slot) => slot.sample === null)).toBe(true);
  });

  it('accepts only the matching authoritative final trial', () => {
    let state = begin();
    state = trialSelectionStreamReducer(state, { type: 'event', event: startSelection() });
    state = trialSelectionStreamReducer(state, {
      type: 'event',
      event: event(2, { type: 'trial_created', draftId, trial: finalTrial }),
    });
    expect(state.mode).toBe('completed');
    expect(state.finalTrial?.revisionId).toBe(finalTrial.revisionId);

    const previous = state;
    state = trialSelectionStreamReducer(state, {
      type: 'complete',
      trial: { ...finalTrial, draftId: '20000000-0000-0000-0000-000000000003' },
    });
    expect(state).toBe(previous);
  });
});
