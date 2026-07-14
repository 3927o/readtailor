import type { Briefing } from '@readtailor/contracts';
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

// §11.9 global reading stats: 今日 / 本周 / 累计有效时长 + 当前连续阅读天数.
export interface ReadingStatsGlobal {
  todaySeconds: number;
  weekSeconds: number;
  totalSeconds: number;
  streakDays: number;
}

// §11.10 estimated remaining time. `seconds` is null only when the book's char total is unknown;
// `approximate` is true while the estimate uses the language default speed (insufficient personal sample).
export interface RemainingReadingTime {
  seconds: number | null;
  approximate: boolean;
}

// §11.9 per-book stats: 累计有效时长 / 最近阅读时间 / 全书进度 / 预计剩余阅读时间.
export interface ReadingStatsPerBook {
  totalEffectiveSeconds: number;
  lastReadAt: string | null;
  progressPercent: number;
  remaining: RemainingReadingTime;
}

export interface ReaderBootstrap {
  userBookId: string;
  sharedBookId: string;
  workflowStatus: WorkflowStatus;
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
  briefing: Briefing;
  strategySummary: string;
  resumePosition: ReaderResumePosition | null;
  settings: ReadingSettings;
  readNodes: ReadNode[];
  highlights: Highlight[];
  enhancements: Array<{
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
    briefing: raw.briefing,
    strategySummary: raw.strategySummary,
    resumePosition: raw.resumePosition ?? null,
    settings: raw.settings ?? defaultReadingSettings,
    readNodes: raw.readNodes ?? [],
    highlights: raw.highlights ?? [],
    enhancements: raw.enhancements.map((enhancement) => ({
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

// §11.9 — global reading stats. `day`/`weekStart` are the client's local calendar boundaries so
// 今日/本周 honor its timezone.
export async function getGlobalReadingStats(day: string, weekStart: string): Promise<ReadingStatsGlobal> {
  const params = new URLSearchParams({ day, weekStart });
  return readJson<ReadingStatsGlobal>(await fetch(
    `${apiBaseUrl}/v1/me/reading-stats?${params.toString()}`,
    { credentials: 'include' },
  ));
}

// §11.9/§11.10 — per-book stats (累计时长 / 最近阅读 / 进度 / 预计剩余时间).
export async function getBookReadingStats(userBookId: string): Promise<ReadingStatsPerBook> {
  return readJson<ReadingStatsPerBook>(await fetch(
    `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/reading-stats`,
    { credentials: 'include' },
  ));
}
