import type {
  AskQuestionRequest,
  Briefing,
  ProposalActionResponse,
  ProposalDecisionRequest,
  ProposalFeedbackRequest,
  QaSessionListResponse,
  QaSessionResponse,
  QaStreamEvent,
} from '@readtailor/contracts';
export type {
  QaMessage,
  QaProposalRevisionSummary,
  QaProposalSummary,
  QaQuestionContext,
  QaSessionListItem,
  QaSessionResponse,
  StrategyChangeProposalStatus,
} from '@readtailor/contracts';
import type { TailoredContent, TextRange, WorkflowStatus } from '../user-books/api';
import type { ActivitySlicePayload, HeartbeatPayload } from './session';

export interface ReaderBook {
  id: string;
  title: string;
  authors: string[];
  language: string;
  coverPath: string | null;
}

export interface ReaderOutlineItem {
  section_id: string;
  data_type: string;
  title: string;
  parent_section_id: string | null;
  first_node_order: number;
}

export interface ReaderNode {
  section_id: string;
  segment: number;
  order: number;
  region: string;
  data_type: string;
  title: string;
  parent_section_id: string | null;
  character_count: number;
  block_count: number;
  node_absolute_start?: number;
}

export interface ReadingManifest {
  version: string;
  document: {
    title: string;
    language: string;
  };
  outline: ReaderOutlineItem[];
  nodes: ReaderNode[];
  book_total_characters?: number;
  position_index?: {
    book_total_characters?: number;
  };
}

export interface ReaderDocument {
  userBookId: string;
  bootstrap: ReaderBootstrap;
  book: ReaderBook;
  manifest: ReadingManifest;
  html: string;
  assetBaseUrl: string;
}

export type NodeEnhancementStatus = 'not_applicable' | 'queued' | 'generating' | 'ready' | 'failed';

export interface ReaderNodeEnhancement {
  generationId: string;
  strategyVersionId: string;
  sectionId: string;
  segment: number;
  status: NodeEnhancementStatus;
  tailoredContent: TailoredContent | null;
  errorSummary: string | null;
}

export type ThemeSetting = 'system' | 'paper' | 'night';
export type ContentWidthSetting = 'narrow' | 'medium' | 'wide';

export interface ReadingSettings {
  fontSize: number;
  lineHeight: number;
  contentWidth: ContentWidthSetting;
  theme: ThemeSetting;
}

// §11.5 — a saved reading anchor: block + UTF-16 offset within one node. `clientObservedAt` is the
// ISO time the anchor was read from the DOM (or the moment a TOC jump was clicked); the server merges
// events last-observed-wins by this field so a stale event that arrives late can never overwrite a
// newer position (reader_position_restore_fix §2.3).
export interface ReaderPosition {
  sectionId: string;
  segment: number;
  blockIndex: number;
  offset: number;
  clientObservedAt: string;
}

// The resume anchor delivered with bootstrap carries the server-side metadata needed for the restore
// fallback chain (§3.3): `nodeOrder` locates the nearest still-valid manifest node when the exact
// section/segment is gone, and `manifestVersion` guards against reinterpreting a stale block/offset
// against a changed block algorithm. Kept distinct from the request ReaderPosition so DB metadata
// never leaks into the anchor the client sends back.
export interface ReaderResumePosition extends ReaderPosition {
  nodeOrder: number;
  manifestVersion: string | null;
}

// A single sampling of the reading-anchor line: the focus node `order` and the precise `position`
// read from the SAME [data-node-order] element, so they can never be spliced from two nodes (§2.2).
export interface ObservedReaderAnchor {
  order: number;
  position: ReaderPosition;
}

export interface ReadNode {
  sectionId: string;
  segment: number;
}

// §11.7 — a reader highlight over a [start,end) range within one node. `note` null → plain highlight,
// non-null → highlight with a note. `quoteSnapshot` is the standard-text slice captured server-side at
// highlight time, for the list view and drift fallback.
export interface Highlight {
  id: string;
  sectionId: string;
  segment: number;
  range: TextRange;
  note: string | null;
  quoteSnapshot: string;
  createdAt: string;
  updatedAt: string;
}

export const defaultReadingSettings: ReadingSettings = {
  fontSize: 18,
  lineHeight: 1.95,
  contentWidth: 'medium',
  theme: 'system',
};

export interface ReaderBootstrap {
  userBookId: string;
  sharedBookId: string;
  workflowStatus: WorkflowStatus;
  strategyVersionId: string;
  strategyVersion: number;
  enhancements: ReaderNodeEnhancement[];
  // Structured pre-reading briefing (BriefCard sections). strategySummary stays a raw string.
  briefing: Briefing;
  strategySummary: string;
  // §11.5 last reading position to resume to (null → start from the first node).
  resumePosition: ReaderResumePosition | null;
  // §11.6 the user's global reader settings.
  settings: ReadingSettings;
  // §11.4 nodes already marked read.
  readNodes: ReadNode[];
  // §11.7 the book's highlights, rendered into the first-paint mark pass.
  highlights: Highlight[];
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('readtailor:unauthorized'));
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error : `读取书籍失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

function normalizeBook(raw: Record<string, unknown>, bookId: string): ReaderBook {
  const authors = raw.authors ?? raw.author;
  return {
    id: String(raw.id ?? bookId),
    title: String(raw.title ?? '未命名书籍'),
    authors: Array.isArray(authors)
      ? authors.map(String)
      : typeof authors === 'string' && authors
        ? [authors]
        : [],
    language: String(raw.language ?? 'und'),
    coverPath: typeof raw.coverPath === 'string'
      ? raw.coverPath
      : typeof raw.cover_path === 'string'
        ? raw.cover_path
        : null,
  };
}

export async function getReaderDocument(userBookId: string): Promise<ReaderDocument> {
  const bootstrap = await getReaderBootstrap(userBookId);
  if (bootstrap.workflowStatus !== 'active_reading') {
    throw new Error('这本书还没有完成试读确认。');
  }
  const bookId = bootstrap.sharedBookId;
  const root = `${apiBaseUrl}/v1/books/${encodeURIComponent(bookId)}`;
  const [bookResponse, manifestResponse, contentResponse] = await Promise.all([
    fetch(root, { credentials: 'include' }),
    fetch(`${root}/manifest`, { credentials: 'include' }),
    fetch(`${root}/content`, { credentials: 'include' }),
  ]);

  const [bookRaw, manifest] = await Promise.all([
    readJson<Record<string, unknown>>(bookResponse),
    readJson<ReadingManifest>(manifestResponse),
  ]);
  if (!contentResponse.ok) {
    if (contentResponse.status === 401) window.dispatchEvent(new Event('readtailor:unauthorized'));
    throw new Error(`读取书籍正文失败（${contentResponse.status}）`);
  }
  const contentType = contentResponse.headers.get('content-type') ?? '';
  const html = contentType.includes('application/json')
    ? String((await contentResponse.json() as { html?: unknown }).html ?? '')
    : await contentResponse.text();
  if (!html) {
    throw new Error('书籍正文为空');
  }

  return {
    userBookId,
    bootstrap,
    book: normalizeBook(bookRaw, bookId),
    manifest,
    html,
    assetBaseUrl: `${root}/assets/`,
  };
}

interface RawReaderBootstrap {
  userBookId: string;
  sharedBookId: string;
  workflowStatus: 'active_reading';
  strategyVersionId: string;
  strategyVersion: number;
  briefing: Briefing;
  strategySummary: string;
  resumePosition: ReaderResumePosition | null;
  settings: ReadingSettings;
  readNodes: ReadNode[];
  highlights: Highlight[];
  enhancements: Array<{
    generationId: string;
    strategyVersionId: string;
    sectionId: string;
    segment: number;
    status: 'queued' | 'generating' | 'ready' | 'failed' | 'retrying' | 'superseded';
    result: TailoredContent | null;
  }>;
}

function mapReaderBootstrap(raw: RawReaderBootstrap): ReaderBootstrap {
  return {
    userBookId: raw.userBookId,
    sharedBookId: raw.sharedBookId,
    workflowStatus: raw.workflowStatus,
    strategyVersionId: raw.strategyVersionId,
    strategyVersion: raw.strategyVersion,
    briefing: raw.briefing,
    strategySummary: raw.strategySummary,
    resumePosition: raw.resumePosition ?? null,
    settings: raw.settings ?? defaultReadingSettings,
    readNodes: raw.readNodes ?? [],
    highlights: raw.highlights ?? [],
    enhancements: raw.enhancements.map((enhancement) => ({
      generationId: enhancement.generationId,
      strategyVersionId: enhancement.strategyVersionId,
      sectionId: enhancement.sectionId,
      segment: enhancement.segment,
      status: enhancement.status === 'retrying'
        ? 'generating'
        : enhancement.status === 'superseded'
          ? 'not_applicable'
          : enhancement.status,
      tailoredContent: enhancement.result,
      errorSummary: enhancement.status === 'failed' ? '裁读内容生成失败' : null,
    })),
  };
}

export async function getReaderBootstrap(userBookId: string): Promise<ReaderBootstrap> {
  return mapReaderBootstrap(await readJson<RawReaderBootstrap>(await fetch(
    `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/reader`,
    { credentials: 'include' },
  )));
}

export function mergeReaderBootstrap(
  previous: ReaderBootstrap | undefined,
  incoming: ReaderBootstrap,
): ReaderBootstrap {
  if (!previous) return incoming;
  if (incoming.strategyVersion < previous.strategyVersion) return previous;
  const previousEnhancements = new Map(
    previous.enhancements.map((enhancement) => [enhancement.generationId, enhancement]),
  );
  const enhancements = incoming.strategyVersion === previous.strategyVersion
    ? incoming.enhancements.map((enhancement) => {
        const current = previousEnhancements.get(enhancement.generationId);
        // `ready` is terminal for one generation. A slower reader/focus response may have taken its
        // DB snapshot while the same generation was still queued/generating; never let that stale
        // response remove already-rendered assistance content and reflow the reader backwards.
        return current?.status === 'ready' && enhancement.status !== 'ready'
          ? current
          : enhancement;
      })
    : incoming.enhancements;
  const previousResume = previous.resumePosition;
  if (previousResume && (!incoming.resumePosition
    || previousResume.clientObservedAt > incoming.resumePosition.clientObservedAt)) {
    return { ...incoming, enhancements, resumePosition: previousResume };
  }
  return enhancements === incoming.enhancements ? incoming : { ...incoming, enhancements };
}

// Reports the reader's current (or jumped-to) node so the host grows the lazy-loading window
// and raises the target's generation priority (§6.2 / PRD §11.3). The optional `position` rides
// the same signal to persist the last reading position (§11.5). Returns the fresh bootstrap so
// newly-queued enhancements surface immediately.
export async function reportReaderFocus(
  userBookId: string,
  order: number,
  position?: ReaderPosition,
): Promise<ReaderBootstrap> {
  return mapReaderBootstrap(await readJson<RawReaderBootstrap>(await fetch(
    `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/reader/focus`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(position ? { order, position } : { order }),
    },
  )));
}

// §11.5 — best-effort position save on page-hide / navigate-away. `keepalive` lets the request
// outlive the unload; failures are swallowed (the debounced focus report is the primary path).
export function saveReaderPositionBeacon(userBookId: string, order: number, position: ReaderPosition): void {
  try {
    void fetch(`${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/reader/focus`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order, position }),
    }).catch(() => {});
  } catch {
    // never throw during unload
  }
}

// §11.6 — persist the user's global reader settings (cross-device).
export async function putReadingSettings(settings: ReadingSettings): Promise<ReadingSettings> {
  const body = await readJson<{ settings: ReadingSettings }>(await fetch(
    `${apiBaseUrl}/v1/me/reading-settings`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(settings),
    },
  ));
  return body.settings;
}

// §11.4 — mark a reading node read (monotonic, idempotent). Returns the full read set.
export async function markReadNode(userBookId: string, node: ReadNode): Promise<ReadNode[]> {
  const body = await readJson<{ readNodes: ReadNode[] }>(await fetch(
    `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/reader/read-nodes`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(node),
    },
  ));
  return body.readNodes;
}

// §11.7 — create a highlight (optionally with a note). The server validates the range against the
// node's blocks and returns the stored highlight with its stable id.
export async function createHighlight(
  userBookId: string,
  input: { sectionId: string; segment: number; range: TextRange; note?: string },
): Promise<Highlight> {
  const body = await readJson<{ highlight: Highlight }>(await fetch(
    `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/highlights`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  ));
  return body.highlight;
}

// §11.7 — set or clear a highlight's note (null/blank clears the note, keeps the highlight).
export async function updateHighlightNote(
  userBookId: string,
  highlightId: string,
  note: string | null,
): Promise<Highlight> {
  const body = await readJson<{ highlight: Highlight }>(await fetch(
    `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/highlights/${encodeURIComponent(highlightId)}`,
    {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note }),
    },
  ));
  return body.highlight;
}

// §11.7 — delete a highlight (row + its note). Returns the deleted id.
export async function deleteHighlight(userBookId: string, highlightId: string): Promise<string> {
  const body = await readJson<{ id: string }>(await fetch(
    `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/highlights/${encodeURIComponent(highlightId)}`,
    { method: 'DELETE', credentials: 'include' },
  ));
  return body.id;
}

// §11.8 — fire-and-forget effective-reading heartbeat. Cumulative + idempotent by clientIntervalId, so
// a dropped/duplicated send never double-counts; failures are swallowed. `keepalive` lets a flush on
// pagehide / node-change outlive the unload.
export function sendHeartbeat(userBookId: string, payload: HeartbeatPayload, opts: { keepalive?: boolean } = {}): Promise<void> {
  try {
    return fetch(`${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/reading-sessions/heartbeat`, {
      method: 'POST',
      credentials: 'include',
      ...(opts.keepalive ? { keepalive: true } : {}),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(() => undefined).catch(() => undefined);
  } catch {
    // never throw from a heartbeat
    return Promise.resolve();
  }
}

export function sendActivitySlice(userBookId: string, payload: ActivitySlicePayload, opts: { keepalive?: boolean } = {}): Promise<void> {
  try {
    return fetch(`${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/reading-activity-slices`, {
      method: 'POST',
      credentials: 'include',
      ...(opts.keepalive ? { keepalive: true } : {}),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(() => undefined).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

export type QaProposalStreamEvent = Extract<QaStreamEvent, { type: 'proposal' }>;
export type QaToolStartedStreamEvent = Extract<QaStreamEvent, { type: 'tool_started' }>;
export type QaToolFinishedStreamEvent = Extract<QaStreamEvent, { type: 'tool_finished' }>;
export type QaToolStreamEvent = QaToolStartedStreamEvent | QaToolFinishedStreamEvent;

export interface QaStreamHandlers {
  onSession?(sessionId: string, conversationVersion: number): void;
  onToolStarted?(tool: QaToolStartedStreamEvent): void;
  onToolFinished?(tool: QaToolFinishedStreamEvent): void;
  onAnswer?(chars: string): void;
  onProposal?(proposal: QaProposalStreamEvent): void;
  onProfileUpdated?(): void;
  onDone?(messageId: string, sessionId: string): void;
  onError?(message: string): void;
}

type QaStreamTerminalEvent = 'done' | 'error';

function dispatchQaFrame(frame: string, handlers: QaStreamHandlers): QaStreamTerminalEvent | null {
  const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
  if (!dataLine) return null; // SSE comment / heartbeat
  const payload = dataLine.slice(5).trim();
  if (!payload) return null;
  let event: QaStreamEvent;
  try {
    event = JSON.parse(payload) as QaStreamEvent;
  } catch {
    return null;
  }
  switch (event.type) {
    case 'session': handlers.onSession?.(event.sessionId, event.conversationVersion); break;
    case 'tool_started': handlers.onToolStarted?.(event); break;
    case 'tool_finished': handlers.onToolFinished?.(event); break;
    case 'answer_delta': handlers.onAnswer?.(event.chars); break;
    case 'proposal': handlers.onProposal?.(event); break;
    case 'profile_updated': handlers.onProfileUpdated?.(); break;
    case 'done':
      handlers.onDone?.(event.messageId, event.sessionId);
      return 'done';
    case 'error':
      handlers.onError?.(event.message);
      return 'error';
  }
  return null;
}

function qaRoot(userBookId: string): string {
  return `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/qa`;
}

export async function listQaSessions(
  userBookId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<QaSessionListResponse> {
  const query = new URLSearchParams();
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit) query.set('limit', String(options.limit));
  const suffix = query.size ? `?${query.toString()}` : '';
  return readJson<QaSessionListResponse>(await fetch(`${qaRoot(userBookId)}${suffix}`, {
    credentials: 'include',
  }));
}

export async function getQaSession(userBookId: string, sessionId: string): Promise<QaSessionResponse> {
  return readJson<QaSessionResponse>(await fetch(
    `${qaRoot(userBookId)}/${encodeURIComponent(sessionId)}`,
    { credentials: 'include' },
  ));
}

async function proposalAction(
  userBookId: string,
  proposalId: string,
  action: 'feedback' | 'confirm' | 'reject',
  input: ProposalFeedbackRequest | ProposalDecisionRequest,
): Promise<ProposalActionResponse> {
  return readJson<ProposalActionResponse>(await fetch(
    `${qaRoot(userBookId)}/proposals/${encodeURIComponent(proposalId)}/${action}`,
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    },
  ));
}

export function feedbackQaProposal(
  userBookId: string,
  proposalId: string,
  input: ProposalFeedbackRequest,
): Promise<ProposalActionResponse> {
  return proposalAction(userBookId, proposalId, 'feedback', input);
}

export function confirmQaProposal(
  userBookId: string,
  proposalId: string,
  input: ProposalDecisionRequest,
): Promise<ProposalActionResponse> {
  return proposalAction(userBookId, proposalId, 'confirm', input);
}

export function rejectQaProposal(
  userBookId: string,
  proposalId: string,
  input: ProposalDecisionRequest,
): Promise<ProposalActionResponse> {
  return proposalAction(userBookId, proposalId, 'reject', input);
}

// §8 问 AI — asks a question (new thread, with `anchor`) or a follow-up (`sessionId`), consuming
// the SSE turn. Resolves only after a terminal done/error event. Pre-stream failures and a stream
// that closes before either terminal event reject; in-band failures arrive via handlers.onError.
export async function streamQaAnswer(
  userBookId: string,
  input: AskQuestionRequest,
  handlers: QaStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(
    qaRoot(userBookId),
    {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    },
  );
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes('text/event-stream') || !response.body) {
    if (response.status === 401) window.dispatchEvent(new Event('readtailor:unauthorized'));
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error : `问 AI 请求失败（${response.status}）`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminalEvent: QaStreamTerminalEvent | null = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        terminalEvent = dispatchQaFrame(buffer.slice(0, boundary), handlers) ?? terminalEvent;
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) terminalEvent = dispatchQaFrame(buffer, handlers) ?? terminalEvent;
  } finally {
    reader.releaseLock();
  }
  if (!terminalEvent) {
    throw new Error('问 AI 连接提前结束，请重试。');
  }
}
