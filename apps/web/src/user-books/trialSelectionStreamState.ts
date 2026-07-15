import type { ProvisionalTrialSample } from '@readtailor/contracts';
import type { TrialSelectionClientEvent, TrialSnapshot } from './api/trial';

export type TrialOrdinal = 1 | 2 | 3;
export type TrialSelectionMode = 'idle' | 'selecting' | 'recovering' | 'failed' | 'completed';

export interface TrialSelectionSlotState {
  ordinal: TrialOrdinal;
  tag: 'threshold' | 'typical' | 'hardest';
  sample: ProvisionalTrialSample | null;
}

export interface TrialSelectionStreamState {
  mode: TrialSelectionMode;
  userBookId: string | null;
  draftId: string | null;
  operationId: string | null;
  operationAttempt: number;
  sequence: number;
  speculativeEpoch: number;
  started: boolean;
  slots: [TrialSelectionSlotState, TrialSelectionSlotState, TrialSelectionSlotState];
  activeOrdinal: TrialOrdinal;
  finalTrial: TrialSnapshot | null;
  error: string | null;
}

function emptySlots(): TrialSelectionStreamState['slots'] {
  return [
    { ordinal: 1, tag: 'threshold', sample: null },
    { ordinal: 2, tag: 'typical', sample: null },
    { ordinal: 3, tag: 'hardest', sample: null },
  ];
}

export const IDLE_TRIAL_SELECTION_STREAM: TrialSelectionStreamState = {
  mode: 'idle',
  userBookId: null,
  draftId: null,
  operationId: null,
  operationAttempt: 0,
  sequence: 0,
  speculativeEpoch: 0,
  started: false,
  slots: emptySlots(),
  activeOrdinal: 1,
  finalTrial: null,
  error: null,
};

export type TrialSelectionStreamAction =
  | { type: 'begin'; userBookId: string; draftId: string }
  | { type: 'event'; event: TrialSelectionClientEvent }
  | { type: 'recover'; message?: string }
  | { type: 'operation_failed'; message: string }
  | { type: 'complete'; trial: TrialSnapshot }
  | { type: 'select'; ordinal: TrialOrdinal }
  | { type: 'reset' };

function clearProvisional(state: TrialSelectionStreamState): TrialSelectionStreamState {
  return {
    ...state,
    sequence: 0,
    speculativeEpoch: 0,
    started: false,
    slots: emptySlots(),
    activeOrdinal: 1,
    finalTrial: null,
    error: null,
  };
}

function hasFixedSlots(event: Extract<TrialSelectionClientEvent, { type: 'selection_started' }>) {
  return event.slots[0]?.ordinal === 1 && event.slots[0].tag === 'threshold'
    && event.slots[1]?.ordinal === 2 && event.slots[1].tag === 'typical'
    && event.slots[2]?.ordinal === 3 && event.slots[2].tag === 'hardest';
}

export function trialSelectionStreamReducer(
  state: TrialSelectionStreamState,
  action: TrialSelectionStreamAction,
): TrialSelectionStreamState {
  if (action.type === 'reset') return IDLE_TRIAL_SELECTION_STREAM;
  if (action.type === 'begin') {
    return {
      ...IDLE_TRIAL_SELECTION_STREAM,
      mode: 'selecting',
      userBookId: action.userBookId,
      draftId: action.draftId,
      slots: emptySlots(),
    };
  }
  if (action.type === 'select') return { ...state, activeOrdinal: action.ordinal };
  if (action.type === 'recover') {
    return { ...state, mode: 'recovering', ...(action.message ? { error: action.message } : {}) };
  }
  if (action.type === 'operation_failed') {
    return { ...clearProvisional(state), mode: 'failed', error: action.message };
  }
  if (action.type === 'complete') {
    if (state.draftId && action.trial.draftId !== state.draftId) return state;
    return { ...state, mode: 'completed', finalTrial: action.trial, error: null };
  }

  const event = action.event;
  if (state.userBookId !== event.userBookId) return state;
  if (state.operationId && state.operationId !== event.operationId) return state;
  if (event.operationAttempt < state.operationAttempt) return state;

  let next = state.operationId ? state : { ...state, operationId: event.operationId };
  if (event.operationAttempt > next.operationAttempt) {
    next = {
      ...clearProvisional(next),
      mode: 'selecting',
      operationAttempt: event.operationAttempt,
    };
  }
  if (event.sequence <= next.sequence) return state;
  next = { ...next, sequence: event.sequence };

  if ('speculativeEpoch' in event) {
    if (event.speculativeEpoch < next.speculativeEpoch) return state;
    if (event.speculativeEpoch > next.speculativeEpoch && event.type !== 'speculative_reset') {
      next = {
        ...clearProvisional(next),
        operationAttempt: event.operationAttempt,
        sequence: event.sequence,
      };
    }
    next = { ...next, speculativeEpoch: event.speculativeEpoch };
  }

  switch (event.type) {
    case 'speculative_reset':
      return {
        ...clearProvisional(next),
        mode: 'selecting',
        operationAttempt: event.operationAttempt,
        sequence: event.sequence,
        speculativeEpoch: event.speculativeEpoch,
      };
    case 'selection_started':
      if (event.draftId !== next.draftId || !hasFixedSlots(event)) return state;
      return {
        ...next,
        mode: 'selecting',
        started: true,
        slots: emptySlots(),
        error: null,
      };
    case 'fragment_selected': {
      if (!next.started || event.draftId !== next.draftId) return state;
      const slot = next.slots[event.sample.ordinal - 1];
      if (!slot || slot.tag !== event.sample.tag) return state;
      const slots = [...next.slots] as TrialSelectionStreamState['slots'];
      slots[event.sample.ordinal - 1] = { ...slot, sample: event.sample };
      return { ...next, slots };
    }
    case 'trial_created':
      if (event.draftId !== next.draftId || event.trial.draftId !== next.draftId) return state;
      return { ...next, mode: 'completed', finalTrial: event.trial, error: null };
    case 'error':
      return { ...next, mode: 'recovering', error: event.message };
  }
}
