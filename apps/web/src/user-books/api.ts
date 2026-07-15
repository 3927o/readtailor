import type {
  Briefing,
  CurrentReadingSetupOperationResponse,
  InterviewStreamEvent,
  ReadingNodePreview,
  ReadingSetupOperationResponse,
  SharedBookStatus,
  StrategyReviewResponse,
  StrategyRevisionStreamEvent,
  TrialSelectionStreamEvent,
  TrialReviewResponse,
  TrialSegment,
} from '@readtailor/contracts';
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

export interface UserBookDetail extends UserBookSummary {
  currentStrategyDraftVersionId: string | null;
  currentStrategyVersionId: string | null;
  currentTrialRevisionId: string | null;
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
  status: 'asking' | 'generating' | 'completing' | 'failed';
  turnInProgress: boolean;
  canResume: boolean;
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
  trialCandidatePreviews: ReadingNodePreview[];
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

interface TrialSampleFields {
  id: string;
  ordinal: number;
  status: TrialSegment['status'];
  chapterPath: string[];
  selectionReason: string;
  originalHtml: string;
  viewedAt: string | null;
}

export type TrialSample =
  | (TrialSampleFields & { status: 'pending' | 'generating' | 'failed'; tailoredContent: null })
  | (TrialSampleFields & { status: 'ready'; tailoredContent: TailoredContent });

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
): Promise<T> {
  return readJson<T>(await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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

interface RawUserBookDetail {
  book: RawShelfItem;
  currentStrategyDraftVersionId?: string | null;
  currentStrategyVersionId?: string | null;
  currentTrialRevisionId?: string | null;
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

type RawStrategySnapshot = StrategyReviewResponse;
type RawTrialSnapshot = TrialReviewResponse;

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
    status: raw.status === 'active'
      ? raw.currentQuestion ? 'asking' : 'generating'
      : raw.status === 'completed' ? 'completing' : 'failed',
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

function mapStrategy(raw: RawStrategySnapshot): StrategySnapshot {
  return {
    draftId: raw.draft.id,
    draftVersion: raw.draft.version,
    readingBriefing: raw.draft.readingBriefing,
    userFacingSummary: raw.draft.userFacingSummary,
    trialCandidatePreviews: raw.trialCandidatePreviews,
    adjustmentCount: raw.adjustmentCount,
    adjustmentLimit: raw.adjustmentLimit,
    canAdjust: raw.canAdjust,
  };
}

function mapTrialSample(segment: TrialSegment): TrialSample {
  const fields = {
    id: segment.id,
    ordinal: segment.ordinal,
    chapterPath: segment.chapterPath,
    selectionReason: segment.selectionReason,
    originalHtml: segment.originalHtml,
    viewedAt: segment.viewedAt,
  };
  if (segment.status === 'ready') {
    return { ...fields, status: segment.status, tailoredContent: segment.result };
  }
  return { ...fields, status: segment.status, tailoredContent: null };
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
    samples: raw.segments.map(mapTrialSample),
    errorSummary: raw.status === 'failed' ? '至少一个片段在技术重试后仍未成功。' : null,
  };
}

export async function getUserBooks(): Promise<UserBookListResponse> {
  const raw = await get<{ books: RawShelfItem[] }>(`${apiBaseUrl}/v1/user-books`);
  return { userBooks: raw.books.map(mapShelfItem) };
}

export async function getUserBook(userBookId: string): Promise<UserBookDetail> {
  const raw = await get<RawUserBookDetail>(userBookRoot(userBookId));
  return {
    ...mapShelfItem(raw.book),
    currentStrategyDraftVersionId: raw.currentStrategyDraftVersionId ?? null,
    currentStrategyVersionId: raw.currentStrategyVersionId ?? null,
    currentTrialRevisionId: raw.currentTrialRevisionId ?? null,
  };
}

export async function getInterview(userBookId: string): Promise<InterviewSnapshot> {
  return mapInterview(await get<RawInterviewSnapshot>(`${userBookRoot(userBookId)}/interview`));
}

export async function startInterview(userBookId: string): Promise<InterviewSnapshot> {
  return mapInterview(await post<RawInterviewSnapshot>(`${userBookRoot(userBookId)}/interview/start`));
}

export async function resumeInterview(userBookId: string): Promise<InterviewSnapshot> {
  return mapInterview(await post<RawInterviewSnapshot>(`${userBookRoot(userBookId)}/interview/resume`));
}

// Handlers for the streaming answer endpoint (§4.2). Every callback is optional so a caller
// can subscribe to only the deltas it renders. `onQuestionFinal` delivers the authoritative
// next question; `onDone` fires when the interview finished (with the new workflow status);
// `onError` reports an in-band failure after the stream opened.
export interface InterviewStreamHandlers {
  onEvent?(event: InterviewClientStreamEvent): void;
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

type InterviewDraftFinalEvent = Extract<InterviewStreamEvent, { type: 'draft_final' }>;
export type InterviewClientStreamEvent =
  | Exclude<InterviewStreamEvent, InterviewDraftFinalEvent>
  | (Omit<InterviewDraftFinalEvent, 'strategy'> & { strategy: StrategySnapshot });

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
    case 'concluding': handlers.onConcluding?.(); break;
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
    case 'done': handlers.onDone?.(event.workflowStatus as WorkflowStatus); break;
    case 'error': handlers.onError?.(event.message); break;
  }
}

async function consumeInterviewStream(
  response: Response,
  handlers: InterviewStreamHandlers,
): Promise<void> {
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
  let terminal = false;
  const dispatchHandlers: InterviewStreamHandlers = {
    ...handlers,
    onEvent(event) {
      if (
        event.type === 'question_final'
        || event.type === 'draft_final'
        || event.type === 'done'
        || event.type === 'error'
      ) {
        terminal = true;
      }
      handlers.onEvent?.(event);
    },
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        dispatchInterviewFrame(buffer.slice(0, boundary), dispatchHandlers);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (!terminal) throw new ApiError('连接中断，正在恢复访谈。', 0);
  } finally {
    reader.releaseLock();
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
  await consumeInterviewStream(response, handlers);
}

export async function streamResumeInterview(
  userBookId: string,
  handlers: InterviewStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${userBookRoot(userBookId)}/interview/resume/stream`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    ...(signal ? { signal } : {}),
  });
  await consumeInterviewStream(response, handlers);
}

export async function getStrategy(userBookId: string, draftId?: string): Promise<StrategySnapshot> {
  const path = draftId
    ? `${userBookRoot(userBookId)}/strategy/versions/${encodeURIComponent(draftId)}`
    : `${userBookRoot(userBookId)}/strategy`;
  return mapStrategy(await get<RawStrategySnapshot>(path));
}

export function submitStrategyFeedback(
  userBookId: string,
  draftId: string,
  feedback: string,
  idempotencyKey: string,
): Promise<StrategySnapshot> {
  return post<RawStrategySnapshot>(`${userBookRoot(userBookId)}/strategy/feedback`, {
    strategyDraftVersionId: draftId,
    feedback,
    idempotencyKey,
  }).then(mapStrategy);
}

type StrategyRevisionFinalEvent = Extract<StrategyRevisionStreamEvent, { type: 'revision_final' }>;
export type StrategyRevisionClientEvent =
  | Exclude<StrategyRevisionStreamEvent, StrategyRevisionFinalEvent>
  | (Omit<StrategyRevisionFinalEvent, 'strategy'> & { strategy: StrategySnapshot });

export interface StrategyRevisionStreamHandlers {
  onEvent(event: StrategyRevisionClientEvent): void;
}

function dispatchStrategyRevisionFrame(
  frame: string,
  handlers: StrategyRevisionStreamHandlers,
): StrategyRevisionClientEvent['type'] | null {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return null;
  const payload = dataLine.slice(5).trim();
  if (!payload) return null;
  let event: StrategyRevisionStreamEvent;
  try {
    event = JSON.parse(payload) as StrategyRevisionStreamEvent;
  } catch {
    return null;
  }
  const clientEvent: StrategyRevisionClientEvent = event.type === 'revision_final'
    ? { ...event, strategy: mapStrategy(event.strategy) }
    : event;
  handlers.onEvent(clientEvent);
  return clientEvent.type;
}

async function consumeStrategyRevisionStream(
  response: Response,
  handlers: StrategyRevisionStreamHandlers,
): Promise<void> {
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
  let terminal = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const type = dispatchStrategyRevisionFrame(buffer.slice(0, boundary), handlers);
        if (type === 'revision_final' || type === 'error') terminal = true;
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (!terminal) throw new ApiError('连接中断，正在恢复处理方式修订。', 0);
  } finally {
    reader.releaseLock();
  }
}

async function streamStrategyRevisionRequest(
  path: string,
  body: Record<string, unknown>,
  handlers: StrategyRevisionStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  await consumeStrategyRevisionStream(response, handlers);
}

export function streamStrategyFeedback(
  userBookId: string,
  draftId: string,
  feedback: string,
  idempotencyKey: string,
  handlers: StrategyRevisionStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  return streamStrategyRevisionRequest(
    `${userBookRoot(userBookId)}/strategy/feedback/stream`,
    { strategyDraftVersionId: draftId, feedback, idempotencyKey },
    handlers,
    signal,
  );
}

type TrialSelectionFinalEvent = Extract<TrialSelectionStreamEvent, { type: 'trial_created' }>;
export type TrialSelectionClientEvent =
  | Exclude<TrialSelectionStreamEvent, TrialSelectionFinalEvent>
  | (Omit<TrialSelectionFinalEvent, 'trial'> & { trial: TrialSnapshot });

export interface TrialSelectionStreamHandlers {
  onEvent(event: TrialSelectionClientEvent): void;
}

function dispatchTrialSelectionFrame(
  frame: string,
  handlers: TrialSelectionStreamHandlers,
): TrialSelectionClientEvent['type'] | null {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return null;
  const payload = dataLine.slice(5).trim();
  if (!payload) return null;
  let event: TrialSelectionStreamEvent;
  try {
    event = JSON.parse(payload) as TrialSelectionStreamEvent;
  } catch {
    return null;
  }
  const clientEvent: TrialSelectionClientEvent = event.type === 'trial_created'
    ? { ...event, trial: mapTrial(event.trial) }
    : event;
  handlers.onEvent(clientEvent);
  return clientEvent.type;
}

async function consumeTrialSelectionStream(
  response: Response,
  handlers: TrialSelectionStreamHandlers,
): Promise<void> {
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
  let terminal = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const type = dispatchTrialSelectionFrame(buffer.slice(0, boundary), handlers);
        if (type === 'trial_created' || type === 'error') terminal = true;
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
    if (!terminal) throw new ApiError('连接中断，正在恢复试读片段选择。', 0);
  } finally {
    reader.releaseLock();
  }
}

export async function streamApproveStrategyForTrial(
  userBookId: string,
  draftId: string,
  idempotencyKey: string,
  handlers: TrialSelectionStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${userBookRoot(userBookId)}/strategy/approve/stream`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategyDraftVersionId: draftId, idempotencyKey }),
    ...(signal ? { signal } : {}),
  });
  await consumeTrialSelectionStream(response, handlers);
}

export async function approveStrategyForTrial(
  userBookId: string,
  draftId: string,
  idempotencyKey: string,
): Promise<TrialSnapshot> {
  const result = await post<{ trialRevisionId: string }>(`${userBookRoot(userBookId)}/strategy/approve`, {
    strategyDraftVersionId: draftId,
    idempotencyKey,
  });
  return getTrial(userBookId, result.trialRevisionId);
}

export async function getTrial(userBookId: string, trialRevisionId?: string): Promise<TrialSnapshot> {
  const path = trialRevisionId
    ? `${userBookRoot(userBookId)}/trial/revisions/${encodeURIComponent(trialRevisionId)}`
    : `${userBookRoot(userBookId)}/trial`;
  return mapTrial(await get<RawTrialSnapshot>(path));
}

export function getCurrentReadingSetupOperation(
  userBookId: string,
): Promise<CurrentReadingSetupOperationResponse> {
  return get(`${userBookRoot(userBookId)}/reading-setup-operation/current`);
}

export function getReadingSetupOperation(
  userBookId: string,
  operationId: string,
): Promise<ReadingSetupOperationResponse> {
  return get(`${userBookRoot(userBookId)}/reading-setup-operation/${encodeURIComponent(operationId)}`);
}

export function resumeReadingSetupOperation(
  userBookId: string,
  operationId: string,
): Promise<ReadingSetupOperationResponse> {
  return post(`${userBookRoot(userBookId)}/reading-setup-operation/${encodeURIComponent(operationId)}/resume`);
}

export function markTrialSampleViewed(
  userBookId: string,
  revisionId: string,
  sampleId: string,
): Promise<TrialSnapshot> {
  return post<RawTrialSnapshot>(`${userBookRoot(userBookId)}/trial/viewed`, {
    trialRevisionId: revisionId,
    trialSegmentId: sampleId,
  }).then(mapTrial);
}

export function retryTrial(userBookId: string): Promise<TrialSnapshot> {
  return post<RawTrialSnapshot>(`${userBookRoot(userBookId)}/trial/retry`).then(mapTrial);
}

export function submitTrialFeedback(
  userBookId: string,
  revisionId: string,
  feedback: string,
  idempotencyKey: string,
): Promise<StrategySnapshot> {
  return post<RawStrategySnapshot>(`${userBookRoot(userBookId)}/trial/feedback`, {
    trialRevisionId: revisionId,
    feedback,
    idempotencyKey,
  }).then(mapStrategy);
}

export function streamTrialFeedback(
  userBookId: string,
  revisionId: string,
  feedback: string,
  idempotencyKey: string,
  handlers: StrategyRevisionStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  return streamStrategyRevisionRequest(
    `${userBookRoot(userBookId)}/trial/feedback/stream`,
    { trialRevisionId: revisionId, feedback, idempotencyKey },
    handlers,
    signal,
  );
}

export async function adoptTrial(
  userBookId: string,
  revisionId: string,
  draftId: string,
): Promise<UserBookSummary> {
  await post(`${userBookRoot(userBookId)}/trial/adopt`, {
    trialRevisionId: revisionId,
    strategyDraftVersionId: draftId,
  });
  return getUserBook(userBookId);
}
