import type {
  TextRange,
  TrialReviewResponse,
  TrialSegment,
  TrialSelectionStreamEvent,
} from '@readtailor/contracts';
export type { TextPosition, TextRange } from '@readtailor/contracts';
import { postJsonSse } from '../sse';
import {
  getJson,
  getUserBook,
  postJson,
  userBookRoot,
  type UserBookDetail,
} from './http';
import {
  streamStrategyRevisionRequest,
  type StrategyRevisionStreamHandlers,
} from './strategy';

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
  sectionId: string;
  segment: number;
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
  canAdopt: boolean;
  samples: TrialSample[];
  errorSummary: string | null;
}

function mapTrialSample(segment: TrialSegment): TrialSample {
  const fields = {
    id: segment.id,
    ordinal: segment.ordinal,
    sectionId: segment.sectionId,
    segment: segment.segment,
    chapterPath: segment.chapterPath,
    selectionReason: segment.selectionReason,
    originalHtml: segment.originalHtml,
    viewedAt: segment.viewedAt,
  };
  if (segment.status === 'ready') {
    const result = segment.result as TailoredContent | null;
    if (result) return { ...fields, status: segment.status, tailoredContent: result };
    // eslint-disable-next-line no-console
    console.error('[trial] ready segment is missing tailored content', { segmentId: segment.id });
    return { ...fields, status: 'failed', tailoredContent: null };
  }
  return { ...fields, status: segment.status, tailoredContent: null };
}

export function mapTrial(raw: TrialReviewResponse): TrialSnapshot {
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
    canAdopt: raw.canAdopt,
    samples: raw.segments.map(mapTrialSample),
    errorSummary: raw.status === 'failed' ? '至少一个片段在技术重试后仍未成功。' : null,
  };
}

type TrialSelectionFinalEvent = Extract<TrialSelectionStreamEvent, { type: 'trial_created' }>;
export type TrialSelectionClientEvent =
  | Exclude<TrialSelectionStreamEvent, TrialSelectionFinalEvent>
  | (Omit<TrialSelectionFinalEvent, 'trial'> & { trial: TrialSnapshot });

export interface TrialSelectionStreamHandlers {
  onEvent(event: TrialSelectionClientEvent): void;
}

function dispatchTrialSelectionEvent(
  event: TrialSelectionStreamEvent,
  handlers: TrialSelectionStreamHandlers,
): void {
  const clientEvent: TrialSelectionClientEvent = event.type === 'trial_created'
    ? { ...event, trial: mapTrial(event.trial) }
    : event;
  handlers.onEvent(clientEvent);
}

export async function streamApproveStrategyForTrial(
  userBookId: string,
  draftId: string,
  idempotencyKey: string,
  handlers: TrialSelectionStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await postJsonSse<TrialSelectionStreamEvent>({
    path: `${userBookRoot(userBookId)}/strategy/approve/stream`,
    body: { strategyDraftVersionId: draftId, idempotencyKey },
    onEvent: (event) => dispatchTrialSelectionEvent(event, handlers),
    isTerminal: (event) => event.type === 'trial_created' || event.type === 'error',
    missingTerminalMessage: '连接中断，正在恢复试读片段选择。',
    ...(signal ? { signal } : {}),
  });
}

export async function getTrial(userBookId: string, trialRevisionId?: string): Promise<TrialSnapshot> {
  const path = trialRevisionId
    ? `${userBookRoot(userBookId)}/trial/revisions/${encodeURIComponent(trialRevisionId)}`
    : `${userBookRoot(userBookId)}/trial`;
  return mapTrial(await getJson<TrialReviewResponse>(path));
}

export function markTrialSampleViewed(
  userBookId: string,
  revisionId: string,
  sampleId: string,
): Promise<TrialSnapshot> {
  return postJson<TrialReviewResponse>(`${userBookRoot(userBookId)}/trial/viewed`, {
    trialRevisionId: revisionId,
    trialSegmentId: sampleId,
  }).then(mapTrial);
}

export function retryTrial(userBookId: string): Promise<TrialSnapshot> {
  return postJson<TrialReviewResponse>(`${userBookRoot(userBookId)}/trial/retry`).then(mapTrial);
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
): Promise<UserBookDetail> {
  await postJson(`${userBookRoot(userBookId)}/trial/adopt`, {
    trialRevisionId: revisionId,
    strategyDraftVersionId: draftId,
  });
  return getUserBook(userBookId);
}
