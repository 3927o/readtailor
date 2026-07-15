import type { Briefing } from '@readtailor/contracts';
import type {
  InterviewClientStreamEvent,
  InterviewOption,
  InterviewSnapshot,
  StrategySnapshot,
} from './api';

export interface InterviewStreamState {
  mode: 'idle' | 'question_streaming' | 'draft_streaming' | 'recovering' | 'error';
  streamId: string | null;
  sequence: number;
  speculativeEpoch: number;
  ack: string;
  prompt: string;
  hint: string;
  options: InterviewOption[];
  sufficiency: number | null;
  briefing: Partial<Briefing>;
  strategySummary: string;
  nodes: StrategySnapshot['trialCandidatePreviews'];
  finalStrategy: StrategySnapshot | null;
  error: string | null;
}

export const IDLE_INTERVIEW_STREAM: InterviewStreamState = {
  mode: 'idle',
  streamId: null,
  sequence: 0,
  speculativeEpoch: 0,
  ack: '',
  prompt: '',
  hint: '',
  options: [],
  sufficiency: null,
  briefing: {},
  strategySummary: '',
  nodes: [],
  finalStrategy: null,
  error: null,
};

export type InterviewStreamAction =
  | { type: 'begin'; sufficiency: number | null }
  | { type: 'recover' }
  | { type: 'reconcile'; snapshot: InterviewSnapshot }
  | { type: 'transport_error'; message: string }
  | { type: 'reset' }
  | { type: 'event'; event: InterviewClientStreamEvent };

function resetProvisional(state: InterviewStreamState, event: InterviewClientStreamEvent): InterviewStreamState {
  return {
    ...state,
    mode: 'question_streaming',
    streamId: event.streamId,
    sequence: event.sequence,
    speculativeEpoch: 'speculativeEpoch' in event ? event.speculativeEpoch : state.speculativeEpoch,
    ack: '',
    prompt: '',
    hint: '',
    options: [],
    briefing: {},
    strategySummary: '',
    nodes: [],
    finalStrategy: null,
    error: null,
  };
}

export function interviewStreamReducer(
  state: InterviewStreamState,
  action: InterviewStreamAction,
): InterviewStreamState {
  if (action.type === 'reset') return IDLE_INTERVIEW_STREAM;
  if (action.type === 'begin') {
    return { ...IDLE_INTERVIEW_STREAM, mode: 'question_streaming', sufficiency: action.sufficiency };
  }
  if (action.type === 'recover') return { ...state, mode: 'recovering', error: null };
  if (action.type === 'reconcile') {
    if (action.snapshot.currentQuestion) return IDLE_INTERVIEW_STREAM;
    if (action.snapshot.status === 'failed') {
      return { ...state, mode: 'error', error: action.snapshot.errorSummary };
    }
    return state;
  }
  if (action.type === 'transport_error') {
    return { ...state, mode: 'recovering', error: action.message };
  }

  const event = action.event;
  let next = state;
  if (state.streamId !== event.streamId) {
    next = resetProvisional(state, event);
  } else if (event.sequence <= state.sequence) {
    return state;
  } else {
    next = { ...state, sequence: event.sequence };
  }
  if ('speculativeEpoch' in event) {
    if (event.speculativeEpoch < next.speculativeEpoch) return state;
    if (event.speculativeEpoch > next.speculativeEpoch && event.type !== 'speculative_reset') {
      next = resetProvisional(next, event);
    }
    next = { ...next, speculativeEpoch: event.speculativeEpoch };
  }

  switch (event.type) {
    case 'speculative_reset':
      return resetProvisional(next, event);
    case 'ack_delta': return { ...next, ack: next.ack + event.chars };
    case 'prompt_delta': return { ...next, prompt: next.prompt + event.chars };
    case 'hint_delta': return { ...next, hint: next.hint + event.chars };
    case 'option_added':
      return next.options.some((option) => option.id === event.id)
        ? next
        : { ...next, options: [...next.options, { id: event.id, label: event.label }] };
    case 'sufficiency': return { ...next, sufficiency: event.value };
    case 'draft_started':
      return {
        ...next,
        mode: 'draft_streaming',
        briefing: {},
        strategySummary: '',
        nodes: [],
      };
    case 'briefing_delta': {
      const key: keyof Briefing = event.field === 'book_identity'
        ? 'bookIdentity'
        : event.field === 'assumed_knowledge'
          ? 'assumedKnowledge'
          : event.field === 'reading_advice'
            ? 'readingAdvice'
            : 'arc';
      return {
        ...next,
        mode: 'draft_streaming',
        briefing: { ...next.briefing, [key]: (next.briefing[key] ?? '') + event.chars },
      };
    }
    case 'strategy_delta':
      return { ...next, mode: 'draft_streaming', strategySummary: next.strategySummary + event.chars };
    case 'reading_node_added':
      return next.nodes.some((node) => node.ordinal === event.node.ordinal)
        ? next
        : { ...next, mode: 'draft_streaming', nodes: [...next.nodes, event.node] };
    case 'draft_final':
      return {
        ...next,
        mode: 'draft_streaming',
        briefing: event.strategy.readingBriefing,
        strategySummary: event.strategy.userFacingSummary,
        nodes: event.strategy.trialCandidatePreviews,
        finalStrategy: event.strategy,
      };
    case 'question_final':
      return { ...IDLE_INTERVIEW_STREAM, streamId: event.streamId, sequence: event.sequence };
    case 'done': return next;
    case 'error': return { ...next, mode: 'error', error: event.message };
  }
}
