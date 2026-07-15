import type {
  StrategyReviewResponse,
  StrategyRevisionStreamEvent,
} from '@readtailor/contracts';
import { postJsonSse } from '../sse';
import { getJson, userBookRoot } from './http';

export interface StrategySnapshot {
  draftId: string;
  draftVersion: number;
  readingBriefing: StrategyReviewResponse['draft']['readingBriefing'];
  userFacingSummary: string;
  trialCandidatePreviews: StrategyReviewResponse['trialCandidatePreviews'];
  adjustmentCount: number;
  adjustmentLimit: number;
  canAdjust: boolean;
}

export function mapStrategy(raw: StrategyReviewResponse): StrategySnapshot {
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

export async function getStrategy(userBookId: string, draftId?: string): Promise<StrategySnapshot> {
  const path = draftId
    ? `${userBookRoot(userBookId)}/strategy/versions/${encodeURIComponent(draftId)}`
    : `${userBookRoot(userBookId)}/strategy`;
  return mapStrategy(await getJson<StrategyReviewResponse>(path));
}

type StrategyRevisionFinalEvent = Extract<StrategyRevisionStreamEvent, { type: 'revision_final' }>;
export type StrategyRevisionClientEvent =
  | Exclude<StrategyRevisionStreamEvent, StrategyRevisionFinalEvent>
  | (Omit<StrategyRevisionFinalEvent, 'strategy'> & { strategy: StrategySnapshot });

export interface StrategyRevisionStreamHandlers {
  onEvent(event: StrategyRevisionClientEvent): void;
}

function dispatchStrategyRevisionEvent(
  event: StrategyRevisionStreamEvent,
  handlers: StrategyRevisionStreamHandlers,
): void {
  const clientEvent: StrategyRevisionClientEvent = event.type === 'revision_final'
    ? { ...event, strategy: mapStrategy(event.strategy) }
    : event;
  handlers.onEvent(clientEvent);
}

export async function streamStrategyRevisionRequest(
  path: string,
  body: Record<string, unknown>,
  handlers: StrategyRevisionStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  await postJsonSse<StrategyRevisionStreamEvent>({
    path,
    body,
    onEvent: (event) => dispatchStrategyRevisionEvent(event, handlers),
    isTerminal: (event) => event.type === 'revision_final' || event.type === 'error',
    missingTerminalMessage: '连接中断，正在恢复处理方式修订。',
    ...(signal ? { signal } : {}),
  });
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
