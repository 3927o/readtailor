import type { Briefing, InterviewStreamEvent, SharedBookStatus } from '@readtailor/contracts';
import { apiBaseUrl } from '../library/api';

export type WorkflowStatus =
  | 'on_shelf'
  | 'interviewing'
  | 'strategy_review'
  | 'trial_generating'
  | 'trial_generation_failed'
  | 'trial_review'
  | 'active_reading';

export interface UserBookSharedBook {
  id: string;
  status: SharedBookStatus;
  title: string;
  authors: string[];
  coverPath: string | null;
  errorSummary: string | null;
}

export interface ReadingProgressSummary {
  percent: number;
  lastReadAt: string | null;
  estimatedRemainingSeconds: number | null;
}

export interface UserBookSummary {
  id: string;
  workflowStatus: WorkflowStatus;
  updatedAt: string;
  sharedBook: UserBookSharedBook;
  readingProgress: ReadingProgressSummary | null;
}

export interface UserBookListResponse {
  userBooks: UserBookSummary[];
}

export interface InterviewOption {
  id: string;
  label: string;
}

export interface InterviewQuestion {
  id: string;
  ordinal: number;
  maxQuestions: number;
  prompt: string;
  // One-line "why I'm asking" shown under the prompt (prototype screen 05). Optional: the
  // agent supplies it, but questions persisted before the field existed won't have it.
  hint?: string;
  options: InterviewOption[];
  // The agent's reply to the previous answer (empty on the first question) and its
  // self-assessed 0–100 information sufficiency (§3.3).
  acknowledgment: string;
  sufficiency: number;
}

export interface InterviewHistoryItem {
  questionId: string;
  question: string;
  answer: string;
}

export interface InterviewSnapshot {
  status: 'asking' | 'completing' | 'failed';
  history: InterviewHistoryItem[];
  currentQuestion: InterviewQuestion | null;
  errorSummary: string | null;
}

// Mirrors the backend StrategyReviewResponse.draft — no fabricated titles, paragraph
// splitting, or inferred flags (§5). The page owns presentation of these raw strings.
export interface StrategySnapshot {
  draftId: string;
  draftVersion: number;
  readingBriefing: Briefing;
  userFacingSummary: string;
  adjustmentCount: number;
  adjustmentLimit: number;
  canAdjust: boolean;
}

export interface TextPosition {
  blockIndex: number;
  offset: number;
}

export interface TextRange {
  start: TextPosition;
  end: TextPosition;
}

export interface TailoredAnnotation {
  id: string;
  range: TextRange;
  content: string;
}

export interface TailoredContent {
  guide: string | null;
  annotations: TailoredAnnotation[];
  afterReading: string | null;
}

export interface TrialSample {
  id: string;
  ordinal: number;
  chapterPath: string[];
  originalHtml: string;
  viewedAt: string | null;
  tailoredContent: TailoredContent;
}

export interface TrialSnapshot {
  revisionId: string;
  revision: number;
  draftId: string;
  status: 'generating' | 'failed' | 'ready';
  progress: { completed: number; total: 3 };
  adjustmentCount: number;
  adjustmentLimit: number;
  canAdjust: boolean;
  allViewed: boolean;
  samples: TrialSample[];
  errorSummary: string | null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('readtailor:unauthorized'));
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new ApiError(
      typeof body?.error === 'string' ? body.error : `请求失败（${response.status}）`,
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

function userBookRoot(userBookId: string): string {
  return `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}`;
}

async function get<T>(path: string): Promise<T> {
  return readJson<T>(await fetch(path, { credentials: 'include' }));
}

async function post<T>(
  path: string,
  body: Record<string, unknown> = {},
  includeIdempotencyKey = true,
): Promise<T> {
  return readJson<T>(await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(includeIdempotencyKey ? { idempotencyKey: crypto.randomUUID() } : {}), ...body }),
  }));
}

interface RawShelfItem {
  id: string;
  sharedBookId: string;
  sharedBookStatus: SharedBookStatus;
  workflowStatus: WorkflowStatus;
  title: string;
  authors: string[];
  coverPath: string | null;
  errorSummary: string | null;
  progress: number | null;
  lastActivityAt: string;
}

interface RawInterviewSnapshot {
  status: 'active' | 'completed' | 'cancelled';
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

interface RawStrategySnapshot {
  draft: {
    id: string;
    version: number;
    readingBriefing: Briefing;
    userFacingSummary: string;
  };
  adjustmentCount: number;
  adjustmentLimit: number;
  canAdjust: boolean;
}

interface RawTrialSnapshot {
  trialRevisionId: string;
  revision: number;
  status: 'draft' | 'generating' | 'ready' | 'published' | 'adopted' | 'failed' | 'superseded';
  strategyDraftVersionId: string;
  segments: Array<{
    id: string;
    ordinal: number;
    chapterPath: string[];
    originalHtml: string;
    status: 'pending' | 'generating' | 'ready' | 'failed';
    result: TailoredContent | null;
    viewedAt: string | null;
  }>;
  adjustmentCount: number;
  adjustmentLimit: number;
  canAdjust: boolean;
  canAdopt: boolean;
}

function mapShelfItem(item: RawShelfItem): UserBookSummary {
  return {
    id: item.id,
    workflowStatus: item.workflowStatus,
    updatedAt: item.lastActivityAt,
    sharedBook: {
      id: item.sharedBookId,
      status: item.sharedBookStatus,
      title: item.title,
      authors: item.authors,
      coverPath: item.coverPath,
      errorSummary: item.errorSummary,
    },
    readingProgress: item.progress === null ? null : {
      percent: item.progress * 100,
      lastReadAt: item.lastActivityAt,
      // TODO: backend does not yet expose a remaining-time estimate; null = unknown.
      estimatedRemainingSeconds: null,
    },
  };
}

function mapInterview(raw: RawInterviewSnapshot): InterviewSnapshot {
  return {
    status: raw.status === 'active' ? 'asking' : raw.status === 'completed' ? 'completing' : 'failed',
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

function mapStrategy(raw: RawStrategySnapshot): StrategySnapshot {
  return {
    draftId: raw.draft.id,
    draftVersion: raw.draft.version,
    readingBriefing: raw.draft.readingBriefing,
    userFacingSummary: raw.draft.userFacingSummary,
    adjustmentCount: raw.adjustmentCount,
    adjustmentLimit: raw.adjustmentLimit,
    canAdjust: raw.canAdjust,
  };
}

function emptyTailoredContent(): TailoredContent {
  return { guide: null, annotations: [], afterReading: null };
}

function mapTrial(raw: RawTrialSnapshot): TrialSnapshot {
  const published = raw.status === 'ready' || raw.status === 'published' || raw.status === 'adopted';
  return {
    revisionId: raw.trialRevisionId,
    revision: raw.revision,
    draftId: raw.strategyDraftVersionId,
    status: raw.status === 'failed' ? 'failed' : published ? 'ready' : 'generating',
    progress: {
      completed: raw.segments.filter((segment) => segment.status === 'ready').length,
      total: 3,
    },
    adjustmentCount: raw.adjustmentCount,
    adjustmentLimit: raw.adjustmentLimit,
    canAdjust: raw.canAdjust,
    allViewed: raw.canAdopt,
    samples: published ? raw.segments.map((segment) => ({
      id: segment.id,
      ordinal: segment.ordinal,
      chapterPath: segment.chapterPath,
      originalHtml: segment.originalHtml,
      viewedAt: segment.viewedAt,
      tailoredContent: segment.result ?? emptyTailoredContent(),
    })) : [],
    errorSummary: raw.status === 'failed' ? '至少一个片段在技术重试后仍未成功。' : null,
  };
}

export async function getUserBooks(): Promise<UserBookListResponse> {
  const raw = await get<{ books: RawShelfItem[] }>(`${apiBaseUrl}/v1/user-books`);
  return { userBooks: raw.books.map(mapShelfItem) };
}

export async function getUserBook(userBookId: string): Promise<UserBookSummary> {
  const raw = await get<{ book: RawShelfItem }>(`${userBookRoot(userBookId)}/workflow`);
  return mapShelfItem(raw.book);
}

export async function getInterview(userBookId: string): Promise<InterviewSnapshot> {
  return mapInterview(await get<RawInterviewSnapshot>(`${userBookRoot(userBookId)}/interview`));
}

// Handlers for the streaming answer endpoint (§4.2). Every callback is optional so a caller
// can subscribe to only the deltas it renders. `onQuestionFinal` delivers the authoritative
// next question; `onDone` fires when the interview finished (with the new workflow status);
// `onError` reports an in-band failure after the stream opened.
export interface InterviewStreamHandlers {
  onAck?(chars: string): void;
  onPrompt?(chars: string): void;
  onHint?(chars: string): void;
  onOption?(option: InterviewOption): void;
  onSufficiency?(value: number): void;
  onConcluding?(): void;
  onQuestionFinal?(question: InterviewQuestion): void;
  onDone?(workflowStatus: WorkflowStatus): void;
  onError?(message: string): void;
}

function dispatchInterviewFrame(frame: string, handlers: InterviewStreamHandlers): void {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return; // SSE comment / heartbeat
  const payload = dataLine.slice(5).trim();
  if (!payload) return;
  let event: InterviewStreamEvent;
  try {
    event = JSON.parse(payload) as InterviewStreamEvent;
  } catch {
    return;
  }
  switch (event.type) {
    case 'ack_delta': handlers.onAck?.(event.chars); break;
    case 'prompt_delta': handlers.onPrompt?.(event.chars); break;
    case 'hint_delta': handlers.onHint?.(event.chars); break;
    case 'option_added': handlers.onOption?.({ id: event.id, label: event.label }); break;
    case 'sufficiency': handlers.onSufficiency?.(event.value); break;
    case 'concluding': handlers.onConcluding?.(); break;
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
    case 'done': handlers.onDone?.(event.workflowStatus as WorkflowStatus); break;
    case 'error': handlers.onError?.(event.message); break;
  }
}

// Submits an answer and consumes the SSE turn (§4.3). Resolves when the stream ends; the
// real source of truth is still the database, so on any failure the caller should fall back
// to GET /interview. Pre-stream failures (stale question, etc.) reject with an ApiError.
export async function streamInterviewAnswer(
  userBookId: string,
  input: { questionId: string; optionId?: string; text?: string },
  handlers: InterviewStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${userBookRoot(userBookId)}/interview/answers`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      idempotencyKey: crypto.randomUUID(),
      questionId: input.questionId,
      selectedOptionIds: input.optionId ? [input.optionId] : [],
      freeText: input.text ?? null,
    }),
    ...(signal ? { signal } : {}),
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes('text/event-stream') || !response.body) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new ApiError(
      typeof body?.error === 'string' ? body.error : `请求失败（${response.status}）`,
      response.status,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        dispatchInterviewFrame(buffer.slice(0, boundary), handlers);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function getStrategy(userBookId: string): Promise<StrategySnapshot> {
  return mapStrategy(await get<RawStrategySnapshot>(`${userBookRoot(userBookId)}/strategy`));
}

export function submitStrategyFeedback(userBookId: string, draftId: string, feedback: string): Promise<StrategySnapshot> {
  return post<RawStrategySnapshot>(`${userBookRoot(userBookId)}/strategy/feedback`, {
    strategyDraftVersionId: draftId,
    feedback,
  }).then(mapStrategy);
}

export async function approveStrategyForTrial(userBookId: string, draftId: string): Promise<TrialSnapshot> {
  await post(`${userBookRoot(userBookId)}/strategy/approve`, { strategyDraftVersionId: draftId }, false);
  return getTrial(userBookId);
}

export async function getTrial(userBookId: string): Promise<TrialSnapshot> {
  return mapTrial(await get<RawTrialSnapshot>(`${userBookRoot(userBookId)}/trial`));
}

export function markTrialSampleViewed(
  userBookId: string,
  revisionId: string,
  sampleId: string,
): Promise<TrialSnapshot> {
  return post<RawTrialSnapshot>(`${userBookRoot(userBookId)}/trial/viewed`, {
    trialRevisionId: revisionId,
    trialSegmentId: sampleId,
  }, false).then(mapTrial);
}

export function retryTrial(userBookId: string): Promise<TrialSnapshot> {
  return post<RawTrialSnapshot>(`${userBookRoot(userBookId)}/trial/retry`, {}, false).then(mapTrial);
}

export function submitTrialFeedback(
  userBookId: string,
  revisionId: string,
  feedback: string,
): Promise<StrategySnapshot> {
  return post<RawStrategySnapshot>(`${userBookRoot(userBookId)}/trial/feedback`, {
    trialRevisionId: revisionId,
    feedback,
  }).then(mapStrategy);
}

export async function adoptTrial(
  userBookId: string,
  revisionId: string,
  draftId: string,
): Promise<UserBookSummary> {
  await post(`${userBookRoot(userBookId)}/trial/adopt`, {
    trialRevisionId: revisionId,
    strategyDraftVersionId: draftId,
  }, false);
  return getUserBook(userBookId);
}
