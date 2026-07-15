import type {
  InterviewStreamEvent,
  UserBookWorkflowStatus,
} from '@readtailor/contracts';
import { postJsonSse } from '../sse';
import { getJson, postJson, userBookRoot } from './http';
import { mapStrategy, type StrategySnapshot } from './strategy';

export interface InterviewOption {
  id: string;
  label: string;
}

export interface InterviewQuestion {
  id: string;
  ordinal: number;
  maxQuestions: number;
  prompt: string;
  hint?: string;
  options: InterviewOption[];
  acknowledgment: string;
  sufficiency: number;
}

export interface InterviewHistoryItem {
  questionId: string;
  question: string;
  answer: string;
}

export interface InterviewSnapshot {
  status: 'asking' | 'generating' | 'failed';
  turnInProgress: boolean;
  canResume: boolean;
  history: InterviewHistoryItem[];
  currentQuestion: InterviewQuestion | null;
  errorSummary: string | null;
}

interface RawInterviewSnapshot {
  status: 'active' | 'completed' | 'cancelled';
  turnInProgress: boolean;
  questionCount: number;
  maxQuestions: 7;
  currentQuestion: {
    id: string;
    acknowledgment: string;
    prompt: string;
    hint?: string;
    options: InterviewOption[];
    allowFreeText: true;
    profileDimension: string;
    sufficiency: number;
  } | null;
  sufficiency: number | null;
  answers: Array<{
    questionId: string;
    question: string;
    selectedOptionIds: string[];
    freeText: string | null;
    answerText: string;
  }>;
}

function mapInterview(raw: RawInterviewSnapshot): InterviewSnapshot {
  return {
    status: raw.status === 'active'
      ? raw.currentQuestion ? 'asking' : 'generating'
      : raw.status === 'completed' ? 'generating' : 'failed',
    turnInProgress: raw.turnInProgress,
    canResume: raw.status === 'active' && !raw.currentQuestion && !raw.turnInProgress,
    history: raw.answers.map((answer, index) => ({
      questionId: answer.questionId,
      question: answer.question || `第 ${index + 1} 问`,
      answer: answer.answerText || answer.freeText || answer.selectedOptionIds.join(' · '),
    })),
    currentQuestion: raw.currentQuestion ? {
      id: raw.currentQuestion.id,
      prompt: raw.currentQuestion.prompt,
      ...(raw.currentQuestion.hint ? { hint: raw.currentQuestion.hint } : {}),
      options: raw.currentQuestion.options,
      ordinal: Math.max(1, Math.min(raw.maxQuestions, raw.questionCount)),
      maxQuestions: raw.maxQuestions,
      acknowledgment: raw.currentQuestion.acknowledgment,
      sufficiency: raw.currentQuestion.sufficiency,
    } : null,
    errorSummary: raw.status === 'cancelled' ? '这次访谈已经取消。' : null,
  };
}

export async function getInterview(userBookId: string): Promise<InterviewSnapshot> {
  return mapInterview(await getJson<RawInterviewSnapshot>(`${userBookRoot(userBookId)}/interview`));
}

export async function startInterview(userBookId: string): Promise<InterviewSnapshot> {
  return mapInterview(await postJson<RawInterviewSnapshot>(`${userBookRoot(userBookId)}/interview/start`));
}

export async function resumeInterview(userBookId: string): Promise<InterviewSnapshot> {
  return mapInterview(await postJson<RawInterviewSnapshot>(`${userBookRoot(userBookId)}/interview/resume`));
}

export interface InterviewStreamHandlers {
  onEvent?(event: InterviewClientStreamEvent): void;
  onAck?(chars: string): void;
  onPrompt?(chars: string): void;
  onHint?(chars: string): void;
  onOption?(option: InterviewOption): void;
  onSufficiency?(value: number): void;
  onQuestionFinal?(question: InterviewQuestion): void;
  onDone?(workflowStatus: UserBookWorkflowStatus): void;
  onError?(message: string): void;
}

type InterviewDraftFinalEvent = Extract<InterviewStreamEvent, { type: 'draft_final' }>;
export type InterviewClientStreamEvent =
  | Exclude<InterviewStreamEvent, InterviewDraftFinalEvent>
  | (Omit<InterviewDraftFinalEvent, 'strategy'> & { strategy: StrategySnapshot });

function dispatchInterviewEvent(event: InterviewStreamEvent, handlers: InterviewStreamHandlers): void {
  const clientEvent: InterviewClientStreamEvent = event.type === 'draft_final'
    ? { ...event, strategy: mapStrategy(event.strategy) }
    : event;
  handlers.onEvent?.(clientEvent);
  switch (event.type) {
    case 'ack_delta': handlers.onAck?.(event.chars); break;
    case 'prompt_delta': handlers.onPrompt?.(event.chars); break;
    case 'hint_delta': handlers.onHint?.(event.chars); break;
    case 'option_added': handlers.onOption?.({ id: event.id, label: event.label }); break;
    case 'sufficiency': handlers.onSufficiency?.(event.value); break;
    case 'speculative_reset':
    case 'draft_started':
    case 'briefing_delta':
    case 'strategy_delta':
    case 'reading_node_added':
    case 'draft_final':
      break;
    case 'question_final':
      handlers.onQuestionFinal?.({
        id: event.question.id,
        prompt: event.question.prompt,
        ...(event.question.hint ? { hint: event.question.hint } : {}),
        options: event.question.options,
        ordinal: event.ordinal,
        maxQuestions: event.maxQuestions,
        acknowledgment: event.question.acknowledgment,
        sufficiency: event.question.sufficiency,
      });
      break;
    case 'done': handlers.onDone?.(event.workflowStatus); break;
    case 'error': handlers.onError?.(event.message); break;
  }
}

async function postInterviewStream(
  path: string,
  body: Record<string, unknown>,
  handlers: InterviewStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await postJsonSse<InterviewStreamEvent>({
    path,
    body,
    onEvent: (event) => dispatchInterviewEvent(event, handlers),
    isTerminal: (event) => (
      event.type === 'question_final'
      || event.type === 'done'
      || event.type === 'error'
    ),
    missingTerminalMessage: '连接中断，正在恢复访谈。',
    ...(signal ? { signal } : {}),
  });
}

export async function streamInterviewAnswer(
  userBookId: string,
  input: { questionId: string; optionId?: string; text?: string },
  handlers: InterviewStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await postInterviewStream(
    `${userBookRoot(userBookId)}/interview/answers`,
    {
      idempotencyKey: crypto.randomUUID(),
      questionId: input.questionId,
      selectedOptionIds: input.optionId ? [input.optionId] : [],
      freeText: input.text ?? null,
    },
    handlers,
    signal,
  );
}

export async function streamResumeInterview(
  userBookId: string,
  handlers: InterviewStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await postInterviewStream(
    `${userBookRoot(userBookId)}/interview/resume/stream`,
    {},
    handlers,
    signal,
  );
}
