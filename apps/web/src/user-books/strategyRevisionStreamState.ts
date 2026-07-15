import type { ReadingNodePreview } from '@readtailor/contracts';
import type { StrategyRevisionClientEvent, StrategySnapshot } from './api/strategy';

export type StrategyRevisionSource = 'strategy_feedback' | 'trial_feedback';

export interface StrategyRevisionStreamState {
  mode: 'idle' | 'streaming' | 'recovering' | 'failed' | 'completed';
  source: StrategyRevisionSource | null;
  userBookId: string | null;
  baseDraftId: string | null;
  baseTrialRevisionId: string | null;
  operationId: string | null;
  operationAttempt: number;
  sequence: number;
  speculativeEpoch: number;
  started: boolean;
  strategySummary: string;
  nodes: ReadingNodePreview[];
  finalStrategy: StrategySnapshot | null;
  error: string | null;
}

export const IDLE_STRATEGY_REVISION_STREAM: StrategyRevisionStreamState = {
  mode: 'idle',
  source: null,
  userBookId: null,
  baseDraftId: null,
  baseTrialRevisionId: null,
  operationId: null,
  operationAttempt: 0,
  sequence: 0,
  speculativeEpoch: 0,
  started: false,
  strategySummary: '',
  nodes: [],
  finalStrategy: null,
  error: null,
};

export type StrategyRevisionStreamAction =
  | {
      type: 'begin';
      source: StrategyRevisionSource;
      userBookId: string;
      baseDraftId: string;
      baseTrialRevisionId: string | null;
    }
  | { type: 'event'; event: StrategyRevisionClientEvent }
  | { type: 'recover'; message?: string }
  | { type: 'operation_failed'; message: string }
  | { type: 'complete'; strategy: StrategySnapshot }
  | { type: 'reset' };

function clearProvisional(state: StrategyRevisionStreamState): StrategyRevisionStreamState {
  return {
    ...state,
    sequence: 0,
    speculativeEpoch: 0,
    started: false,
    strategySummary: '',
    nodes: [],
    finalStrategy: null,
    error: null,
  };
}

export function strategyRevisionStreamReducer(
  state: StrategyRevisionStreamState,
  action: StrategyRevisionStreamAction,
): StrategyRevisionStreamState {
  if (action.type === 'reset') return IDLE_STRATEGY_REVISION_STREAM;
  if (action.type === 'begin') {
    return {
      ...IDLE_STRATEGY_REVISION_STREAM,
      mode: 'streaming',
      source: action.source,
      userBookId: action.userBookId,
      baseDraftId: action.baseDraftId,
      baseTrialRevisionId: action.baseTrialRevisionId,
    };
  }
  if (action.type === 'recover') {
    return { ...state, mode: 'recovering', ...(action.message ? { error: action.message } : {}) };
  }
  if (action.type === 'operation_failed') {
    return { ...clearProvisional(state), mode: 'failed', error: action.message };
  }
  if (action.type === 'complete') {
    return {
      ...state,
      mode: 'completed',
      strategySummary: action.strategy.userFacingSummary,
      nodes: action.strategy.trialCandidatePreviews,
      finalStrategy: action.strategy,
      error: null,
    };
  }

  const event = action.event;
  if (state.userBookId !== event.userBookId) return state;
  if (state.operationId && state.operationId !== event.operationId) return state;
  if (event.operationAttempt < state.operationAttempt) return state;
  let next = state.operationId ? state : { ...state, operationId: event.operationId };
  if (event.operationAttempt > next.operationAttempt) {
    next = {
      ...clearProvisional(next),
      mode: 'streaming',
      operationAttempt: event.operationAttempt,
    };
  }
  if (event.sequence <= next.sequence) return state;
  next = { ...next, sequence: event.sequence };
  if ('speculativeEpoch' in event) {
    if (event.speculativeEpoch < next.speculativeEpoch) return state;
    if (event.speculativeEpoch > next.speculativeEpoch && event.type !== 'speculative_reset') {
      next = { ...clearProvisional(next), operationAttempt: event.operationAttempt, sequence: event.sequence };
    }
    next = { ...next, speculativeEpoch: event.speculativeEpoch };
  }

  switch (event.type) {
    case 'speculative_reset':
      return {
        ...clearProvisional(next),
        mode: 'streaming',
        operationAttempt: event.operationAttempt,
        sequence: event.sequence,
        speculativeEpoch: event.speculativeEpoch,
      };
    case 'revision_started':
      if (
        event.source !== next.source
        || event.baseDraftId !== next.baseDraftId
        || event.baseTrialRevisionId !== next.baseTrialRevisionId
      ) {
        return { ...next, mode: 'recovering', error: '修订基线已经变化，正在重新同步。' };
      }
      return {
        ...next,
        mode: 'streaming',
        started: true,
        strategySummary: '',
        nodes: [],
        error: null,
      };
    case 'strategy_delta':
      return next.started
        ? { ...next, strategySummary: next.strategySummary + event.chars }
        : next;
    case 'reading_node_added':
      return !next.started || next.nodes.some((node) => node.ordinal === event.node.ordinal)
        ? next
        : { ...next, nodes: [...next.nodes, event.node] };
    case 'revision_final':
      return {
        ...next,
        mode: 'completed',
        strategySummary: event.strategy.userFacingSummary,
        nodes: event.strategy.trialCandidatePreviews,
        finalStrategy: event.strategy,
        error: null,
      };
    case 'error':
      return { ...next, mode: 'recovering', error: event.message };
  }
}
