import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type {
  AdoptTrialRequest,
  AdoptTrialResponse,
  ApproveStrategyRequest,
  ApproveStrategyResponse,
  AskQuestionRequest,
  BookReaderProfile,
  Briefing,
  CreateHighlightRequest,
  DeleteHighlightResponse,
  Highlight,
  HighlightListResponse,
  HighlightResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  InterviewQuestion,
  InterviewStateResponse,
  InterviewStreamEvent,
  MarkReadNodeRequest,
  MarkReadNodeResponse,
  MarkTrialSegmentViewedRequest,
  ProposalActionResponse,
  ProposalDecisionRequest,
  ProposalFeedbackRequest,
  ProposedStrategy,
  ProvisionalTrialSample,
  QaQuestionContext,
  QaSessionListResponse,
  QaSessionResponse,
  QaStreamEvent,
  ReaderBootstrap,
  ReaderFocusRequest,
  ReaderPosition,
  ReaderProfile,
  ReadingSettings,
  ReadingSettingsResponse,
  ReadingActivityClassification,
  ReadingActivitySliceRequest,
  ReadingActivitySliceResponse,
  ReadingStatsGlobal,
  ReadingStatsPerBook,
  ReadingStatsQuery,
  ReadingNodePreview,
  ReadingSetupOperationResponse,
  ReadingSetupStreamErrorCode,
  Strategy,
  StrategyReviewResponse,
  StrategyRevisionStreamEvent,
  TextPosition,
  TextRange,
  UpdateHighlightNoteRequest,
  TrialCandidate,
  SubmitInterviewAnswerRequest,
  SubmitStrategyFeedbackRequest,
  SubmitTrialFeedbackRequest,
  TrialReviewResponse,
  TrialSelectionStreamEvent,
  UserBookDetailResponse,
  UserBookShelfItem,
  UserBookShelfResponse,
} from '@readtailor/contracts';
import { DEFAULT_READING_SETTINGS } from '@readtailor/contracts';
import {
  bookPackages,
  bookReadingStats,
  bookReaderProfileVersions,
  dailyReadingTotals,
  highlights,
  interviewAnswers,
  interviewMessages,
  interviewSessions,
  nodeGenerations,
  qaMessages,
  qaSessions,
  readerProfiles,
  readerProfileVersions,
  readerReadNodes,
  readerStates,
  readingSetupOperations,
  readingActivitySlices,
  readingDailyBookStats,
  readingSessions,
  sharedBooks,
  strategyChangeProposals,
  strategyChangeProposalActions,
  strategyChangeProposalRevisions,
  strategyDraftVersions,
  strategyVersions,
  trialRevisions,
  trialSegments,
  userBooks,
  userReadingSettings,
  type Database,
} from '@readtailor/database';
import type {
  AskAiOutcome,
  AskAiToolbox,
  ReadingSetupStreamDelta,
} from '@readtailor/agent-kit';
import { extractNodeSourceFromHtml, extractNodeTexts, sliceNodeSource } from '@readtailor/tailoring';
import type { AskAiEngine } from './ask-ai-engine';
import type { BookService } from './books';
import type { ReadingSetupEngine } from './reading-setup-engine';

// The number of strategy/trial adjustments a user may make before the draft locks. The
// SQL guards below still spell out `< 5` inline; this constant is the value surfaced to the
// client so the frontend can show "还可以调整 N 次" without hardcoding it (§5).
const ADJUSTMENT_LIMIT = 5;

// §6.2 / PRD §11.3 reading window: the current tailoring-eligible node plus the next 3.
const FORMAL_WINDOW_SIZE = 4;
// Background BullMQ priority for formal generations without a reading focus. Well above the
// window band (1..FORMAL_WINDOW_SIZE) so the reader's lookahead is always processed first.
// (BullMQ: lower number = more urgent; 0 would jump ahead of everything, so we never use it.)
const FORMAL_BACKGROUND_PRIORITY = 1000;

// §11.10 implementation parameters (「样本阈值、异常速度过滤和默认速度属于实现参数,不在普通界面展示」).
// Default reading speeds in original-text UTF-16 chars/sec, keyed by primary language subtag. zh ≈ 390
// 字/min; en ≈ 216 wpm × ~5 chars/word ≈ 18 chars/sec; other languages fall back to a generic middle.
const DEFAULT_READING_SPEED_CHARS_PER_SEC: Record<string, number> = { zh: 6.5, en: 18 };
const FALLBACK_READING_SPEED_CHARS_PER_SEC = 9;
// Switch from the language default to the book's own speed only once the forward-reading sample is
// solid enough to trust (both a time and a char floor, so a single burst can't flip it early).
const MIN_PERSONAL_SAMPLE_SECONDS = 180;
const MIN_PERSONAL_SAMPLE_CHARS = 1500;
// Abnormal-speed filter: ignore a personal speed outside a sane band and keep the default instead.
const MIN_REASONABLE_SPEED_CHARS_PER_SEC = 1;
const MAX_REASONABLE_SPEED_CHARS_PER_SEC = 60;
const MAX_HEARTBEAT_INTERVAL_SECONDS = 12 * 60 * 60;
const HEARTBEAT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const HEARTBEAT_ROUNDING_TOLERANCE_SECONDS = 2;

function isValidLocalDate(value: string): boolean {
  return localDateParts(value) !== null;
}

function localDateParts(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
  return valid ? { year, month, day } : null;
}

function localDateTime(value: string): number {
  const parts = localDateParts(value);
  return parts ? Date.UTC(parts.year, parts.month - 1, parts.day) : Number.NaN;
}

export function validateHeartbeat(input: HeartbeatRequest, now: Date): { startedAt: Date; endedAt: Date } {
  const startedAt = new Date(input.startedAt);
  const endedAt = new Date(input.at);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    throw new UserBookError('阅读心跳时间无效', 400);
  }
  if (!isValidLocalDate(input.day)) throw new UserBookError('阅读心跳日期无效', 400);
  if (endedAt.getTime() < startedAt.getTime()) {
    throw new UserBookError('阅读心跳结束时间早于开始时间', 400);
  }
  if (startedAt.getTime() > now.getTime() + HEARTBEAT_CLOCK_SKEW_MS || endedAt.getTime() > now.getTime() + HEARTBEAT_CLOCK_SKEW_MS) {
    throw new UserBookError('阅读心跳时间来自未来', 400);
  }
  const spanSeconds = Math.ceil((endedAt.getTime() - startedAt.getTime()) / 1000);
  if (spanSeconds > MAX_HEARTBEAT_INTERVAL_SECONDS) {
    throw new UserBookError('阅读心跳跨度过长', 400);
  }
  if (input.effectiveSeconds > spanSeconds + HEARTBEAT_ROUNDING_TOLERANCE_SECONDS) {
    throw new UserBookError('有效阅读时长超过心跳跨度', 400);
  }
  if (input.forwardSeconds > input.effectiveSeconds) {
    throw new UserBookError('向前阅读时长超过有效阅读时长', 400);
  }
  return { startedAt, endedAt };
}

export function localDayInTimeZone(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  if (!year || !month || !day) throw new UserBookError('阅读活动时区无效', 400);
  return `${year}-${month}-${day}`;
}

export function validateReadingActivitySlice(
  input: ReadingActivitySliceRequest,
  now: Date,
): { startedAt: Date; endedAt: Date; effectiveSeconds: number; day: string } {
  const startedAt = new Date(input.sliceStartedAt);
  const endedAt = new Date(input.sliceEndedAt);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime())) {
    throw new UserBookError('阅读活动时间无效', 400);
  }
  if (endedAt.getTime() < startedAt.getTime()) {
    throw new UserBookError('阅读活动结束时间早于开始时间', 400);
  }
  if (startedAt.getTime() > now.getTime() + HEARTBEAT_CLOCK_SKEW_MS || endedAt.getTime() > now.getTime() + HEARTBEAT_CLOCK_SKEW_MS) {
    throw new UserBookError('阅读活动时间来自未来', 400);
  }
  const effectiveSeconds = Math.round((endedAt.getTime() - startedAt.getTime()) / 1000);
  if (effectiveSeconds > MAX_HEARTBEAT_INTERVAL_SECONDS) {
    throw new UserBookError('阅读活动跨度过长', 400);
  }
  try {
    return {
      startedAt,
      endedAt,
      effectiveSeconds,
      day: localDayInTimeZone(startedAt.getTime(), input.timezone),
    };
  } catch (error) {
    if (error instanceof UserBookError) throw error;
    throw new UserBookError('阅读活动时区无效', 400);
  }
}

export function validateReadingStatsQuery(query: ReadingStatsQuery): void {
  const day = localDateTime(query.day);
  const weekStart = localDateTime(query.weekStart);
  if (Number.isNaN(day) || Number.isNaN(weekStart)) {
    throw new UserBookError('阅读统计日期无效', 400);
  }
  if (weekStart > day) throw new UserBookError('阅读统计周起始日晚于查询日期', 400);
  if ((day - weekStart) / 86_400_000 > 6) throw new UserBookError('阅读统计周范围无效', 400);
  if (new Date(weekStart).getUTCDay() !== 1) throw new UserBookError('阅读统计周起始日必须是周一', 400);
}

function positionAbsoluteChar(
  meta: ManifestMeta,
  position: ReadingActivitySliceRequest['startPosition'],
): number | null {
  const node = meta.nodesByOrder.get(position.order);
  if (!node || node.sectionId !== position.sectionId || node.segment !== position.segment) return null;
  if (node.blocks.length === 0) {
    return node.nodeStart + Math.min(Math.max(0, position.offset), node.charCount);
  }
  const block = node.blocks.find((item) => item.block_index === position.blockIndex);
  if (!block) return null;
  const beforeBlock = node.blocks
    .filter((item) => item.block_index < position.blockIndex)
    .reduce((sum, item) => sum + Math.max(0, item.block_utf16_length), 0);
  const inBlock = Math.min(Math.max(0, position.offset), Math.max(0, block.block_utf16_length));
  return node.nodeStart + Math.min(node.charCount, beforeBlock + inBlock);
}

export function classifyReadingActivitySlice(
  meta: ManifestMeta,
  input: ReadingActivitySliceRequest,
  effectiveSeconds: number,
): {
  classification: ReadingActivityClassification;
  forwardSeconds: number;
  forwardChars: number;
} {
  if (input.activityArea === 'assistance') {
    return { classification: 'assistance', forwardSeconds: 0, forwardChars: 0 };
  }
  if (input.activityArea === 'reader_chrome') {
    return { classification: 'stationary', forwardSeconds: 0, forwardChars: 0 };
  }
  const startAbs = positionAbsoluteChar(meta, input.startPosition);
  const endAbs = positionAbsoluteChar(meta, input.endPosition);
  if (startAbs === null || endAbs === null) {
    return { classification: 'stationary', forwardSeconds: 0, forwardChars: 0 };
  }
  if (input.discontinuous) {
    return { classification: 'original_jump', forwardSeconds: 0, forwardChars: 0 };
  }
  if (endAbs === startAbs) {
    return { classification: 'stationary', forwardSeconds: 0, forwardChars: 0 };
  }
  if (endAbs < startAbs) {
    return { classification: 'original_reread', forwardSeconds: 0, forwardChars: 0 };
  }
  return {
    classification: 'original_forward',
    forwardSeconds: effectiveSeconds,
    forwardChars: endAbs - startAbs,
  };
}

export function splitActivitySliceByLocalDay(
  startedAt: Date,
  endedAt: Date,
  timezone: string,
): Array<{ day: string; effectiveSeconds: number }> {
  const startMs = startedAt.getTime();
  const endMs = endedAt.getTime();
  const totalSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  const startDay = localDayInTimeZone(startMs, timezone);
  const endDay = localDayInTimeZone(endMs, timezone);
  if (totalSeconds === 0 || startDay === endDay) return [{ day: startDay, effectiveSeconds: totalSeconds }];

  let low = startMs + 1;
  let high = endMs;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (localDayInTimeZone(mid, timezone) === startDay) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  const firstSeconds = Math.max(0, Math.min(totalSeconds, Math.round((low - startMs) / 1000)));
  return [
    { day: startDay, effectiveSeconds: firstSeconds },
    { day: endDay, effectiveSeconds: totalSeconds - firstSeconds },
  ].filter((bucket) => bucket.effectiveSeconds > 0);
}

function allocateBySeconds(total: number, buckets: Array<{ effectiveSeconds: number }>): number[] {
  const totalSeconds = buckets.reduce((sum, bucket) => sum + bucket.effectiveSeconds, 0);
  if (total <= 0 || totalSeconds <= 0) return buckets.map(() => 0);
  let allocated = 0;
  return buckets.map((bucket, index) => {
    if (index === buckets.length - 1) return Math.max(0, total - allocated);
    const value = Math.round((total * bucket.effectiveSeconds) / totalSeconds);
    allocated += value;
    return value;
  });
}

// §11.10 — pick the reading speed for the remaining-time estimate. Uses the book's own forward-reading
// speed (ΣforwardChars / ΣforwardSeconds) once the sample clears both floors and lands in a sane band;
// otherwise the language default, flagged `approximate` so the UI shows「约 X 小时」. Pure/exported for
// unit testing. `forwardSeconds`/`forwardChars` are the §11.10 分母/分子 (forward original-text reading
// only) — never total effective time.
export function resolveReadingSpeed(
  language: string | null,
  forwardSeconds: number,
  forwardChars: number,
): { charsPerSec: number; approximate: boolean } {
  const primary = (language ?? '').toLowerCase().split('-')[0]!;
  const fallback = DEFAULT_READING_SPEED_CHARS_PER_SEC[primary] ?? FALLBACK_READING_SPEED_CHARS_PER_SEC;
  if (forwardSeconds >= MIN_PERSONAL_SAMPLE_SECONDS && forwardChars >= MIN_PERSONAL_SAMPLE_CHARS) {
    const personal = forwardChars / forwardSeconds;
    if (personal >= MIN_REASONABLE_SPEED_CHARS_PER_SEC && personal <= MAX_REASONABLE_SPEED_CHARS_PER_SEC) {
      return { charsPerSec: personal, approximate: false };
    }
  }
  return { charsPerSec: fallback, approximate: true };
}

// §11.9/§11.10 — whole-node original-text progress at a stable node order (the reader progress-bar 口径:
// charactersBefore = Σ character_count for nodes strictly before the current order; 只算原文). Returns
// a null remaining count that the caller maps to an unknown estimate when the manifest carries no
// char counts.
export function computeBookProgress(
  meta: ManifestMeta,
  nodeOrder: number | null,
): { totalChars: number | null; charsBefore: number; remainingChars: number | null; progressPercent: number } {
  if (meta.bookTotalChars === null) {
    return { totalChars: null, charsBefore: 0, remainingChars: null, progressPercent: 0 };
  }
  let charsBefore = 0;
  if (nodeOrder !== null) {
    for (const [order, count] of meta.charCountByOrder) {
      if (order < nodeOrder) charsBefore += count;
    }
  }
  charsBefore = Math.min(charsBefore, meta.bookTotalChars);
  const remainingChars = Math.max(0, meta.bookTotalChars - charsBefore);
  const progressPercent = meta.bookTotalChars > 0
    ? Math.min(100, Math.max(0, Math.round((charsBefore / meta.bookTotalChars) * 100)))
    : 0;
  return { totalChars: meta.bookTotalChars, charsBefore, remainingChars, progressPercent };
}

// Calendar-day arithmetic on 'YYYY-MM-DD' strings via UTC midnight, so it never drifts by a day from
// local timezone offsets — the strings are opaque calendar dates, not instants.
function addCalendarDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// §11.9 current consecutive reading streak: the run of days that each have any effective reading,
// ending at `today` — or at yesterday when today has none yet, so an active streak isn't reported as
// broken merely because today's reading hasn't happened. Pure/exported for unit testing.
export function computeStreakDays(activeDays: Set<string>, today: string): number {
  let cursor = activeDays.has(today) ? today : addCalendarDays(today, -1);
  let streak = 0;
  while (activeDays.has(cursor)) {
    streak += 1;
    cursor = addCalendarDays(cursor, -1);
  }
  return streak;
}

type ManifestBlock = {
  block_index: number;
  block_utf16_length: number;
};

type ManifestNode = {
  section_id: string;
  segment: number;
  order: number;
  region?: string;
  data_type?: string;
  title?: string;
  parent_section_id?: string | null;
  tailoring_eligible: boolean;
  blocks: ManifestBlock[];
  node_absolute_start?: number;
};

type ManifestOutline = {
  section_id: string;
  title: string;
  parent_section_id: string | null;
};

type ReadingManifest = {
  version?: string;
  nodes: ManifestNode[];
  outline: ManifestOutline[];
};

export interface ContentGenerationEnqueuer {
  // `priority` maps to BullMQ job priority (lower = more urgent; omitted → background).
  // Re-enqueuing an id that is still waiting bumps its priority (§6.2 jump提权).
  enqueue(input: { generationId: string; userBookId: string; scope: 'trial' | 'formal'; priority?: number }): Promise<void>;
}

// ReaderBootstrap is now a formal contract (ReaderBootstrapSchema); re-exported so existing
// importers of it from this module keep working.
export type { ReaderBootstrap };

export class UserBookError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409 | 503,
  ) {
    super(message);
    this.name = 'UserBookError';
  }
}

class ReadingSetupLeaseLostError extends Error {
  constructor() {
    super('reading setup operation lease lost');
    this.name = 'ReadingSetupLeaseLostError';
  }
}

class ReadingSetupClaimConflictError extends Error {
  constructor() {
    super('reading setup operation claim conflict');
    this.name = 'ReadingSetupClaimConflictError';
  }
}

class InterviewTurnLeaseLostError extends Error {
  constructor() {
    super('interview turn lease lost');
    this.name = 'InterviewTurnLeaseLostError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type QaSessionCursor = { updatedAt: string; sessionId: string };

export function encodeQaSessionCursor(cursor: QaSessionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeQaSessionCursor(cursor: string): QaSessionCursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<QaSessionCursor>;
    if (
      typeof value.updatedAt !== 'string'
      || !Number.isFinite(Date.parse(value.updatedAt))
      || typeof value.sessionId !== 'string'
      || !UUID_RE.test(value.sessionId)
    ) {
      throw new Error('invalid cursor payload');
    }
    return { updatedAt: new Date(value.updatedAt).toISOString(), sessionId: value.sessionId };
  } catch {
    throw new UserBookError('问答历史游标无效', 400);
  }
}

export function proposalActionPayloadMatches(
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  return isDeepStrictEqual(stored, incoming);
}

type ReaderProfilePatch = NonNullable<AskAiOutcome['readerProfilePatch']>;

function mergeProfileList(
  current: string[],
  additions: string[] = [],
  removals: string[] = [],
): string[] {
  const removeSet = new Set(removals);
  return [...new Set([
    ...current.filter((item) => !removeSet.has(item)),
    ...additions,
  ])];
}

export function applyReaderProfilePatch(
  profile: ReaderProfile,
  patch: ReaderProfilePatch,
): ReaderProfile {
  return {
    ...profile,
    knowledge: mergeProfileList(
      profile.knowledge,
      patch.knowledge,
      patch.remove_knowledge,
    ),
    explanationPreferences: mergeProfileList(
      profile.explanationPreferences,
      patch.explanation_preferences,
      patch.remove_explanation_preferences,
    ),
  };
}

function postgresConstraintName(error: unknown): string | null {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const pg = candidate as { code?: unknown; constraint_name?: unknown };
    if (pg.code === '23505' && typeof pg.constraint_name === 'string') {
      return pg.constraint_name;
    }
  }
  return null;
}

function asManifest(value: unknown): ReadingManifest {
  const manifest = value as Partial<ReadingManifest>;
  if (!Array.isArray(manifest.nodes) || !Array.isArray(manifest.outline)) {
    throw new UserBookError('书籍阅读索引不可用', 409);
  }
  return manifest as ReadingManifest;
}

interface ManifestMetaNode {
  sectionId: string;
  segment: number;
  region: string | null;
  dataType: string | null;
  nodeStart: number;
  charCount: number;
  blocks: ManifestBlock[];
}

// The manifest is immutable per (immutable) book package, so memoize its position-relevant metadata
// per process. The position-save path (§11.5) stamps `version` onto every reader_states row for
// future migration识别 and validates the reported `order` against `nodesByOrder` (§4.3) — but it runs
// on each scroll settle, so it must not re-read the manifest artifact each time.
export interface ManifestMeta {
  version: string | null;
  // §11.10 progress/remaining inputs: the book's primary language (for the default-speed lookup), the
  // total original-text character count, and per-order original character counts (for the whole-node
  // charactersBefore 口径 the reader progress bar uses). All null/empty when the manifest is unreadable.
  language: string | null;
  bookTotalChars: number | null;
  charCountByOrder: Map<number, number>;
  nodesByOrder: Map<number, ManifestMetaNode>;
}

// §2.2/§4.3: an anchor is self-consistent only when the manifest node it names by `order` really
// carries that section/segment. When the manifest is unreadable (empty map) we can't validate, so we
// allow the write best-effort rather than block the read. Exported so the guard is unit-testable
// without a database.
export function positionMatchesManifest(
  meta: ManifestMeta,
  order: number,
  sectionId: string,
  segment: number,
): boolean {
  if (meta.nodesByOrder.size === 0) return true;
  const node = meta.nodesByOrder.get(order);
  return Boolean(node) && node!.sectionId === sectionId && node!.segment === segment;
}

const manifestMetaCache = new Map<string, ManifestMeta>();
async function getManifestMeta(books: BookService, sharedBookId: string): Promise<ManifestMeta> {
  const cached = manifestMetaCache.get(sharedBookId);
  if (cached) return cached;
  const empty = (): ManifestMeta => ({
    version: null,
    language: null,
    bookTotalChars: null,
    charCountByOrder: new Map(),
    nodesByOrder: new Map(),
  });
  let meta: ManifestMeta = empty();
  try {
    const raw = (await books.getManifest(sharedBookId)) as {
      version?: unknown;
      book_total_characters?: unknown;
      document?: { language?: unknown };
      nodes?: unknown;
    } | null;
    const nodesByOrder = new Map<number, ManifestMetaNode>();
    const charCountByOrder = new Map<number, number>();
    let sumChars = 0;
    let sawChars = false;
    if (Array.isArray(raw?.nodes)) {
      for (const node of raw.nodes as Array<ManifestNode & { character_count?: unknown }>) {
        if (typeof node?.order === 'number' && typeof node?.section_id === 'string' && typeof node?.segment === 'number') {
          const charCount = typeof node.character_count === 'number' && Number.isFinite(node.character_count)
            ? Math.max(0, node.character_count)
            : 0;
          const blocks = Array.isArray(node.blocks)
            ? node.blocks.filter((block) => (
                typeof block?.block_index === 'number'
                && typeof block?.block_utf16_length === 'number'
                && Number.isFinite(block.block_utf16_length)
              ))
            : [];
          const nodeStart = typeof node.node_absolute_start === 'number'
            && Number.isFinite(node.node_absolute_start)
            ? Math.max(0, node.node_absolute_start)
            : sumChars;
          nodesByOrder.set(node.order, {
            sectionId: node.section_id,
            segment: node.segment,
            region: typeof node.region === 'string' ? node.region : null,
            dataType: typeof node.data_type === 'string' ? node.data_type : null,
            nodeStart,
            charCount,
            blocks,
          });
          if (typeof node.character_count === 'number' && Number.isFinite(node.character_count)) {
            charCountByOrder.set(node.order, charCount);
            sumChars += charCount;
            sawChars = true;
          }
        }
      }
    }
    // Prefer the manifest's own book_total_characters; fall back to the sum of per-node counts so the
    // ratio stays self-consistent with charCountByOrder when the top-level total is absent.
    const bookTotalChars = typeof raw?.book_total_characters === 'number' && Number.isFinite(raw.book_total_characters)
      ? raw.book_total_characters
      : sawChars ? sumChars : null;
    meta = {
      version: typeof raw?.version === 'string' ? raw.version : null,
      language: typeof raw?.document?.language === 'string' ? raw.document.language : null,
      bookTotalChars,
      charCountByOrder,
      nodesByOrder,
    };
  } catch {
    meta = empty();
  }
  manifestMetaCache.set(sharedBookId, meta);
  return meta;
}

function mapQuestion(value: {
  id: string;
  acknowledgment: string;
  prompt: string;
  hint?: string;
  options: Array<{ id: string; label: string }>;
  allow_text: true;
  profile_dimension: string;
  sufficiency: number;
}): InterviewQuestion {
  return {
    id: value.id,
    acknowledgment: value.acknowledgment,
    prompt: value.prompt,
    ...(value.hint ? { hint: value.hint } : {}),
    options: value.options,
    allowFreeText: true,
    profileDimension: value.profile_dimension,
    sufficiency: value.sufficiency,
  };
}

function mapBookReaderProfile(value: {
  summary: string;
  motivations: string[];
  prior_knowledge: string[];
  reading_goals: string[];
  likely_barriers: string[];
}): BookReaderProfile {
  return {
    purpose: value.motivations.join('；'),
    existingKnowledge: value.prior_knowledge,
    desiredDepthOrOutcome: value.reading_goals.join('；'),
    likelyObstacles: value.likely_barriers,
    expectedCommitment: '按实际阅读进度持续推进，不要求一次生成整本书。',
    otherConclusions: [value.summary],
  };
}

function mapBriefing(value: {
  book_identity: string;
  arc: string;
  assumed_knowledge: string;
  reading_advice: string;
}): Briefing {
  // snake_case (agent ReadingBriefingSchema) → camelCase contracts Briefing. Stored as jsonb
  // and rendered by the frontend BriefCard as four labelled sections.
  return {
    bookIdentity: value.book_identity,
    arc: value.arc,
    assumedKnowledge: value.assumed_knowledge,
    readingAdvice: value.reading_advice,
  };
}

function mapStrategy(value: {
  goals: string[];
  expression_principles: string[];
  guide: { enabled: boolean; objectives: string[] };
  annotations: { enabled: boolean; focuses: string[]; exclusions: string[] };
  after_reading: { enabled: boolean; objectives: string[] };
  trial_candidates: Array<{ section_id: string; segment: number; reason: string }>;
}): Strategy {
  // Lossless snake_case → camelCase projection of the agent's structured strategy.
  // The agent now produces goals / expression_principles / per-section enabled
  // directly (agent-kit ReadingStrategySchema), so the host no longer fabricates
  // expressionPrinciples or forces enabled=true — the faithful strategy reaches
  // the generator (§3.6).
  return {
    goals: value.goals,
    expressionPrinciples: value.expression_principles,
    guide: { enabled: value.guide.enabled, objectives: value.guide.objectives },
    annotations: {
      enabled: value.annotations.enabled,
      focuses: value.annotations.focuses,
      exclusions: value.annotations.exclusions,
    },
    afterReading: {
      enabled: value.after_reading.enabled,
      objectives: value.after_reading.objectives,
    },
    trialCandidates: value.trial_candidates.map((candidate) => ({
      sectionId: candidate.section_id,
      segment: candidate.segment,
      reason: candidate.reason,
    })),
  };
}

// The 问 AI strategy-change proposal (§8.2) is the tailoring core without trial_candidates — a
// mid-reading adjustment has no trial phase. Same snake_case → camelCase projection as
// mapStrategy, minus that field. Persisted as strategy_change_proposals.proposed_strategy.
function mapProposedStrategy(value: {
  goals: string[];
  expression_principles: string[];
  guide: { enabled: boolean; objectives: string[] };
  annotations: { enabled: boolean; focuses: string[]; exclusions: string[] };
  after_reading: { enabled: boolean; objectives: string[] };
}): ProposedStrategy {
  return {
    goals: value.goals,
    expressionPrinciples: value.expression_principles,
    guide: { enabled: value.guide.enabled, objectives: value.guide.objectives },
    annotations: {
      enabled: value.annotations.enabled,
      focuses: value.annotations.focuses,
      exclusions: value.annotations.exclusions,
    },
    afterReading: {
      enabled: value.after_reading.enabled,
      objectives: value.after_reading.objectives,
    },
  };
}

function changedStrategyFields(current: Strategy, proposed: ProposedStrategy): string[] {
  const fields: Array<keyof ProposedStrategy> = [
    'goals',
    'expressionPrinciples',
    'guide',
    'annotations',
    'afterReading',
  ];
  return fields.filter(
    (field) => JSON.stringify(current[field]) !== JSON.stringify(proposed[field]),
  );
}

type QaContextPrecision = 'exact' | 'approximate' | 'node';

function compareTextPositions(left: TextPosition, right: TextPosition): number {
  return left.blockIndex === right.blockIndex
    ? left.offset - right.offset
    : left.blockIndex - right.blockIndex;
}

function qaRangeText(
  html: string,
  sectionId: string,
  segment: number,
  range: TextRange,
): string {
  const source = extractNodeSourceFromHtml(html, sectionId, segment);
  const sliced = sliceNodeSource(source, {
    start: { block_index: range.start.blockIndex, offset: range.start.offset },
    end: { block_index: range.end.blockIndex, offset: range.end.offset },
  });
  return sliced.blocks.map((block) => block.text).join('\n\n').trim();
}

function normalizeQaQuestionContext(
  raw: QaQuestionContext | Record<string, unknown>,
  manifest: ReadingManifest,
  html: string,
  strict: boolean,
): { context: QaQuestionContext; precision: QaContextPrecision } {
  const value = raw as Record<string, unknown>;
  let sectionId = typeof value.sectionId === 'string' ? value.sectionId : '';
  let segment = typeof value.segment === 'number' ? value.segment : 0;
  let node = manifest.nodes.find(
    (candidate) => candidate.section_id === sectionId && candidate.segment === segment,
  );
  if (!node && !strict) {
    const requestedOrder = typeof value.nodeOrder === 'number' ? value.nodeOrder : 1;
    node = [...manifest.nodes]
      .sort((left, right) => Math.abs(left.order - requestedOrder) - Math.abs(right.order - requestedOrder))[0];
    if (node) {
      sectionId = node.section_id;
      segment = node.segment;
    }
  }
  if (!node) throw new UserBookError('提问上下文对应的阅读节点不存在', 409);
  const source = extractNodeSourceFromHtml(html, sectionId, segment);
  if (source.blocks.length === 0) throw new UserBookError('提问上下文没有可读原文', 409);
  const first = source.blocks[0]!;
  const last = source.blocks[source.blocks.length - 1]!;
  const blockByIndex = new Map(source.blocks.map((block) => [block.block_index, block]));
  const manifestVersion = manifest.version;
  const submittedVersion = typeof value.manifestVersion === 'string' ? value.manifestVersion : undefined;
  if (strict && submittedVersion && manifestVersion && submittedVersion !== manifestVersion) {
    throw new UserBookError('阅读内容版本已变化，请重新选择原文后提问', 409);
  }
  if (strict && typeof value.nodeOrder === 'number' && value.nodeOrder !== node.order) {
    throw new UserBookError('提问上下文节点位置已变化，请重试', 409);
  }

  const normalizePoint = (point: unknown, exact: boolean): TextPosition | undefined => {
    if (typeof point !== 'object' || point === null) return undefined;
    const candidate = point as Record<string, unknown>;
    if (typeof candidate.blockIndex !== 'number' || typeof candidate.offset !== 'number') return undefined;
    const block = blockByIndex.get(candidate.blockIndex);
    if (!block) return undefined;
    if (exact && (candidate.offset < 0 || candidate.offset > block.text.length)) return undefined;
    return {
      blockIndex: candidate.blockIndex,
      offset: Math.max(0, Math.min(candidate.offset, block.text.length)),
    };
  };
  const normalizeRange = (candidate: unknown, exact: boolean): TextRange | undefined => {
    if (typeof candidate !== 'object' || candidate === null) return undefined;
    const range = candidate as Record<string, unknown>;
    const start = normalizePoint(range.start, exact);
    const end = normalizePoint(range.end, exact);
    if (!start || !end || compareTextPositions(start, end) >= 0) return undefined;
    return { start, end };
  };

  if (value.anchor === 'highlight' && value.precision === 'exact') {
    const range = normalizeRange(value.range, true);
    if (range) {
      return {
        context: {
          anchor: 'highlight',
          precision: 'exact',
          nodeOrder: node.order,
          sectionId,
          segment,
          range,
          quoteSnapshot: qaRangeText(html, sectionId, segment, range).slice(0, 12000),
          ...(manifestVersion ? { manifestVersion } : {}),
        },
        precision: 'exact',
      };
    }
    if (strict) throw new UserBookError('划线范围已失效，请重新选择原文', 409);
  }

  if (value.anchor === 'screen' && value.precision === 'approximate') {
    const focus = normalizePoint(value.focus, false) ?? {
      blockIndex: first.block_index,
      offset: 0,
    };
    let range = normalizeRange(value.range, false);
    if (!range) {
      const focusAt = source.blocks.findIndex((block) => block.block_index === focus.blockIndex);
      const startBlock = source.blocks[Math.max(0, focusAt - 1)] ?? first;
      const endBlock = source.blocks[Math.min(source.blocks.length - 1, focusAt + 1)] ?? last;
      range = {
        start: { blockIndex: startBlock.block_index, offset: 0 },
        end: { blockIndex: endBlock.block_index, offset: endBlock.text.length },
      };
    }
    return {
      context: {
        anchor: 'screen',
        precision: 'approximate',
        nodeOrder: node.order,
        sectionId,
        segment,
        focus,
        range,
        quoteSnapshot: qaRangeText(html, sectionId, segment, range).slice(0, 12000),
        ...(manifestVersion ? { manifestVersion } : {}),
      },
      precision: 'approximate',
    };
  }

  const fullRange: TextRange = {
    start: { blockIndex: first.block_index, offset: 0 },
    end: { blockIndex: last.block_index, offset: last.text.length },
  };
  return {
    context: {
      anchor: 'screen',
      precision: 'approximate',
      nodeOrder: node.order,
      sectionId,
      segment,
      focus: fullRange.start,
      range: fullRange,
      quoteSnapshot: qaRangeText(html, sectionId, segment, fullRange).slice(0, 12000),
      ...(manifestVersion ? { manifestVersion } : {}),
    },
    precision: 'node',
  };
}

function chapterPath(node: ManifestNode, outline: ManifestOutline[]): string[] {
  const byId = new Map(outline.map((item) => [item.section_id, item]));
  const path: string[] = [];
  let current = byId.get(node.section_id);
  while (current) {
    if (current.title.trim()) path.unshift(current.title.trim());
    current = current.parent_section_id ? byId.get(current.parent_section_id) : undefined;
  }
  return path.length > 0 ? path : [node.title?.trim() || '未命名章节'];
}

// Shared range-against-blocks bounds check for both trial fragments and highlights (§11.7): the range
// must lie within the node's actual blocks, offsets within each block's standard-text length, and be
// non-empty. `label` names the caller so the rejection reads sensibly ('试读片段' / '划线').
function assertRangeWithinBlocks(
  blocks: Array<{ block_index: number; text: string }>,
  range: TextRange,
  label = '试读片段',
) {
  const byIndex = new Map(blocks.map((block) => [block.block_index, block]));
  const startBlock = byIndex.get(range.start.blockIndex);
  const endBlock = byIndex.get(range.end.blockIndex);
  if (!startBlock || !endBlock || range.start.blockIndex > range.end.blockIndex) {
    throw new UserBookError(`${label}范围超出节点`, 409);
  }
  if (range.start.offset < 0 || range.start.offset > startBlock.text.length) {
    throw new UserBookError(`${label}起点越界`, 409);
  }
  if (range.end.offset < 0 || range.end.offset > endBlock.text.length) {
    throw new UserBookError(`${label}终点越界`, 409);
  }
  if (range.start.blockIndex === range.end.blockIndex && range.start.offset >= range.end.offset) {
    throw new UserBookError(`${label}范围为空`, 409);
  }
}

type TrialRetrySegmentSource = Pick<
  typeof trialSegments.$inferSelect,
  | 'id'
  | 'ordinal'
  | 'sectionId'
  | 'segment'
  | 'startBlockIndex'
  | 'startOffset'
  | 'endBlockIndex'
  | 'endOffset'
  | 'selectionReason'
>;

type TrialRetryGenerationSource = Pick<
  typeof nodeGenerations.$inferSelect,
  | 'id'
  | 'generationScope'
  | 'trialSegmentId'
  | 'strategyDraftVersionId'
  | 'sectionId'
  | 'segment'
  | 'maxAttempts'
  | 'modelConfigId'
  | 'promptVersion'
>;

export function buildTrialRetryPlan(
  strategyDraftVersionId: string,
  segments: TrialRetrySegmentSource[],
  generations: TrialRetryGenerationSource[],
) {
  const ordered = [...segments].sort((left, right) => left.ordinal - right.ordinal);
  if (
    ordered.length !== 3
    || ordered.some((segment, index) => segment.ordinal !== index + 1)
    || new Set(ordered.map((segment) => segment.id)).size !== 3
  ) {
    throw new UserBookError('失败试读版本的片段数据不完整', 409);
  }
  const generationBySegmentId = new Map<string, TrialRetryGenerationSource>();
  for (const generation of generations) {
    if (
      generation.generationScope !== 'trial'
      || !generation.trialSegmentId
      || generation.strategyDraftVersionId !== strategyDraftVersionId
      || generationBySegmentId.has(generation.trialSegmentId)
    ) {
      throw new UserBookError('失败试读版本的生成任务数据不完整', 409);
    }
    generationBySegmentId.set(generation.trialSegmentId, generation);
  }
  if (generationBySegmentId.size !== 3) {
    throw new UserBookError('失败试读版本的生成任务数据不完整', 409);
  }
  return ordered.map((segment) => {
    const generation = generationBySegmentId.get(segment.id);
    if (
      !generation
      || generation.sectionId !== segment.sectionId
      || generation.segment !== segment.segment
    ) {
      throw new UserBookError('失败试读版本的片段与生成任务不一致', 409);
    }
    return { segment, generation };
  });
}

// The standard-text slice a highlight range covers (reading_contract §2.5), joined across blocks with
// a newline so a multi-block quote reads naturally. Capped so a long cross-block selection can't bloat
// the row; the snapshot is only for list display and drift fallback, not an authority.
const HIGHLIGHT_QUOTE_MAX = 2000;
function quoteFromBlocks(
  blocks: Array<{ block_index: number; text: string }>,
  range: TextRange,
): string {
  const byIndex = new Map(blocks.map((block) => [block.block_index, block]));
  const parts: string[] = [];
  for (let index = range.start.blockIndex; index <= range.end.blockIndex; index += 1) {
    const block = byIndex.get(index);
    if (!block) continue;
    const from = index === range.start.blockIndex ? range.start.offset : 0;
    const to = index === range.end.blockIndex ? range.end.offset : block.text.length;
    parts.push(block.text.slice(from, to));
  }
  return parts.join('\n').slice(0, HIGHLIGHT_QUOTE_MAX);
}

// Bridges the agent's push-based `onStream` callback to a pull-based async generator so the
// streaming answer endpoint can `yield` deltas as they arrive. `push` buffers events, `drain`
// yields them until `end()`; a failed turn is surfaced by the caller (via the settled turn
// promise), not through the bridge.
function createStreamBridge<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const signal = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    push(item: T) {
      queue.push(item);
      signal();
    },
    end() {
      ended = true;
      signal();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

type UserBookServiceOptions = {
  db: Database;
  books: BookService;
  setupEngine: ReadingSetupEngine;
  askAiEngine: AskAiEngine;
  generations: ContentGenerationEnqueuer;
  modelConfigId: string;
};

type RequestContext = {
  requestId?: string;
};

type InterviewTurnClaim = {
  sessionId: string;
  leaseId: string;
  questionCount: number;
  conversationVersion: number;
};

type InterviewTurnStreamDelta =
  | Exclude<ReadingSetupStreamDelta, { type: 'reading_node_added' }>
  | {
      type: 'reading_node_added';
      speculativeEpoch: number;
      node: ReadingNodePreview;
    };

type InterviewStreamPayload = InterviewStreamEvent extends infer Event
  ? Event extends InterviewStreamEvent
    ? Omit<Event, 'userBookId' | 'streamId' | 'sequence'>
    : never
  : never;

type RevisionTurnStreamDelta =
  | Extract<ReadingSetupStreamDelta, { type: 'speculative_reset' | 'draft_started' | 'strategy_delta' }>
  | {
      type: 'reading_node_added';
      speculativeEpoch: number;
      node: ReadingNodePreview;
    };

type StrategyRevisionStreamPayload = StrategyRevisionStreamEvent extends infer Event
  ? Event extends StrategyRevisionStreamEvent
    ? Omit<Event, 'userBookId' | 'operationId' | 'operationAttempt' | 'sequence'>
    : never
  : never;

type TrialFragmentStreamValue = Extract<ReadingSetupStreamDelta, { type: 'fragment_added' }>['fragment'];

type TrialSelectionTurnStreamDelta =
  | Extract<ReadingSetupStreamDelta, { type: 'speculative_reset' | 'selection_started' }>
  | {
      type: 'fragment_selected';
      speculativeEpoch: number;
      sample: ProvisionalTrialSample;
    };

type TrialSelectionStreamPayload = TrialSelectionStreamEvent extends infer Event
  ? Event extends TrialSelectionStreamEvent
    ? Omit<Event, 'userBookId' | 'operationId' | 'operationAttempt' | 'sequence'>
    : never
  : never;

type ReadingSetupOperationClaim = {
  operationId: string;
  leaseId: string;
  attemptCount: number;
};

type ReadingSetupOperationCommand = {
  kind: 'strategy_revision' | 'trial_selection';
  source: 'strategy_feedback' | 'trial_feedback' | 'strategy_approve';
  baseStrategyDraftVersionId: string;
  baseTrialRevisionId: string | null;
  idempotencyKey: string;
  payload:
    | {
        source: 'strategy_feedback';
        strategyDraftVersionId: string;
        feedback: string;
      }
    | {
        source: 'trial_feedback';
        strategyDraftVersionId: string;
        trialRevisionId: string;
        feedback: string;
      }
    | {
        source: 'strategy_approve';
        strategyDraftVersionId: string;
      };
};

type ReadingSetupOperationRow = typeof readingSetupOperations.$inferSelect;
type ReadingSetupOperationObservation = {
  operation: ReadingSetupOperationRow;
  leaseExpired: boolean;
};

type PreparedReadingSetupOperation = {
  operation: ReadingSetupOperationRow;
  claim: ReadingSetupOperationClaim | null;
};

const READING_SETUP_OPERATION_LEASE_SQL = sql`interval '6 minutes'`;
const READING_SETUP_OPERATION_RENEW_INTERVAL_MS = 60_000;

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  }
  return value;
}

export function readingSetupOperationRequestHash(
  command: Pick<
    ReadingSetupOperationCommand,
    'source' | 'baseStrategyDraftVersionId' | 'baseTrialRevisionId' | 'payload'
  >,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(command)))
    .digest('hex');
}

const INTERVIEW_TURN_LEASE_SQL = sql`interval '6 minutes'`;
const INTERVIEW_TURN_RENEW_INTERVAL_MS = 60_000;

export function createUserBookService(options: UserBookServiceOptions) {
  return {
    forUser(userId: string, context: RequestContext = {}) {
      return createUserBookServiceForUser(options, userId, context);
    },
  };
}

function createUserBookServiceForUser(
  options: UserBookServiceOptions,
  userId: string,
  requestContext: RequestContext,
) {
  const { db } = options;

  const getOwnedBook = async (userBookId: string) => {
    const [row] = await db
      .select({ userBook: userBooks, sharedBook: sharedBooks })
      .from(userBooks)
      .innerJoin(sharedBooks, eq(sharedBooks.id, userBooks.sharedBookId))
      .where(and(eq(userBooks.id, userBookId), eq(userBooks.userId, userId), isNull(userBooks.deletedAt)))
      .limit(1);
    if (!row) throw new UserBookError('用户书籍不存在', 404);
    return row;
  };

  const readOperationByIdempotencyKey = async (
    userBookId: string,
    idempotencyKey: string,
  ): Promise<ReadingSetupOperationRow | undefined> => db
    .select()
    .from(readingSetupOperations)
    .where(and(
      eq(readingSetupOperations.userBookId, userBookId),
      eq(readingSetupOperations.idempotencyKey, idempotencyKey),
    ))
    .limit(1)
    .then((rows) => rows[0]);

  const readOperationById = async (
    userBookId: string,
    operationId: string,
  ): Promise<ReadingSetupOperationRow | undefined> => db
    .select()
    .from(readingSetupOperations)
    .where(and(
      eq(readingSetupOperations.id, operationId),
      eq(readingSetupOperations.userBookId, userBookId),
    ))
    .limit(1)
    .then((rows) => rows[0]);

  const observeOperationById = async (
    userBookId: string,
    operationId: string,
  ): Promise<ReadingSetupOperationObservation | undefined> => db
    .select({
      operation: readingSetupOperations,
      leaseExpired: sql<boolean>`coalesce(${readingSetupOperations.leaseExpiresAt} <= now(), false)`,
    })
    .from(readingSetupOperations)
    .where(and(
      eq(readingSetupOperations.id, operationId),
      eq(readingSetupOperations.userBookId, userBookId),
    ))
    .limit(1)
    .then((rows) => rows[0]);

  const assertOperationHash = (
    operation: ReadingSetupOperationRow,
    requestHash: string,
  ) => {
    if (operation.requestHash !== requestHash) {
      throw new UserBookError('幂等键已用于不同的阅读准备操作', 409);
    }
  };

  const validateReadingSetupOperation = async (operation: ReadingSetupOperationRow) => {
    const owned = await getOwnedBook(operation.userBookId);
    const book = owned.userBook;
    if (book.currentStrategyDraftVersionId !== operation.baseStrategyDraftVersionId) {
      throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
    }
    const [draft] = await db
      .select({ status: strategyDraftVersions.status })
      .from(strategyDraftVersions)
      .where(and(
        eq(strategyDraftVersions.id, operation.baseStrategyDraftVersionId),
        eq(strategyDraftVersions.userBookId, operation.userBookId),
      ))
      .limit(1);
    if (!draft) throw new UserBookError('处理方式版本不存在', 404);

    if (operation.source === 'strategy_approve') {
      if (
        book.workflowStatus !== 'strategy_review'
        || book.currentTrialRevisionId !== null
        || draft.status !== 'draft'
      ) {
        throw new UserBookError('处理方式已经确认或更新', 409);
      }
      return;
    }

    if (book.adjustmentCount >= ADJUSTMENT_LIMIT) {
      throw new UserBookError('已经达到 5 次调整上限', 409);
    }
    if (operation.source === 'strategy_feedback') {
      if (
        book.workflowStatus !== 'strategy_review'
        || book.currentTrialRevisionId !== null
        || !['draft', 'approved_for_trial'].includes(draft.status)
      ) {
        throw new UserBookError('当前阶段不能修改处理方式', 409);
      }
      return;
    }

    if (
      book.workflowStatus !== 'trial_review'
      || book.currentTrialRevisionId !== operation.baseTrialRevisionId
    ) {
      throw new UserBookError('试读版本已经更新', 409);
    }
    const [revision] = await db
      .select({ status: trialRevisions.status })
      .from(trialRevisions)
      .where(and(
        eq(trialRevisions.id, operation.baseTrialRevisionId!),
        eq(trialRevisions.userBookId, operation.userBookId),
      ))
      .limit(1);
    if (!revision || revision.status !== 'published') {
      throw new UserBookError('试读版本尚未发布或已经更新', 409);
    }
  };

  const resolveReadingSetupOperation = async (
    userBookId: string,
    command: ReadingSetupOperationCommand,
  ): Promise<ReadingSetupOperationRow> => {
    await getOwnedBook(userBookId);
    const requestHash = readingSetupOperationRequestHash(command);
    const existing = await readOperationByIdempotencyKey(userBookId, command.idempotencyKey);
    if (existing) {
      assertOperationHash(existing, requestHash);
      return existing;
    }

    const candidate: ReadingSetupOperationRow = {
      id: randomUUID(),
      userBookId,
      kind: command.kind,
      source: command.source,
      baseStrategyDraftVersionId: command.baseStrategyDraftVersionId,
      baseTrialRevisionId: command.baseTrialRevisionId,
      idempotencyKey: command.idempotencyKey,
      requestHash,
      payload: command.payload,
      status: 'pending',
      attemptCount: 0,
      leaseId: null,
      leaseClaimedAt: null,
      leaseExpiresAt: null,
      resultStrategyDraftVersionId: null,
      resultTrialRevisionId: null,
      errorSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    };
    await validateReadingSetupOperation(candidate);

    try {
      const [created] = await db
        .insert(readingSetupOperations)
        .values({
          id: candidate.id,
          userBookId,
          kind: command.kind,
          source: command.source,
          baseStrategyDraftVersionId: command.baseStrategyDraftVersionId,
          baseTrialRevisionId: command.baseTrialRevisionId,
          idempotencyKey: command.idempotencyKey,
          requestHash,
          payload: command.payload,
        })
        .returning();
      if (!created) throw new Error('failed to create reading setup operation');
      return created;
    } catch (error) {
      const constraint = postgresConstraintName(error);
      if (constraint === 'reading_setup_operations_book_idempotency_unique') {
        const raced = await readOperationByIdempotencyKey(userBookId, command.idempotencyKey);
        if (!raced) throw error;
        assertOperationHash(raced, requestHash);
        return raced;
      }
      if (constraint === 'reading_setup_operations_one_active_per_book') {
        throw new UserBookError('当前已有阅读准备操作正在进行', 409);
      }
      throw error;
    }
  };

  const claimReadingSetupOperation = async (
    operation: ReadingSetupOperationRow,
  ): Promise<ReadingSetupOperationClaim> => {
    if (operation.status === 'completed') {
      throw new UserBookError('阅读准备操作已完成', 409);
    }
    await validateReadingSetupOperation(operation);
    const leaseId = randomUUID();
    const attemptCount = operation.attemptCount + 1;
    const stateGate = operation.source === 'strategy_approve'
      ? sql`exists (
          select 1
          from ${userBooks}
          inner join ${strategyDraftVersions}
            on ${strategyDraftVersions.id} = ${userBooks.currentStrategyDraftVersionId}
          where ${userBooks.id} = ${operation.userBookId}
            and ${userBooks.workflowStatus} = 'strategy_review'
            and ${userBooks.currentStrategyDraftVersionId} = ${operation.baseStrategyDraftVersionId}
            and ${userBooks.currentTrialRevisionId} is null
            and ${strategyDraftVersions.status} = 'draft'
        )`
      : operation.source === 'strategy_feedback'
        ? sql`exists (
            select 1
            from ${userBooks}
            inner join ${strategyDraftVersions}
              on ${strategyDraftVersions.id} = ${userBooks.currentStrategyDraftVersionId}
            where ${userBooks.id} = ${operation.userBookId}
              and ${userBooks.workflowStatus} = 'strategy_review'
              and ${userBooks.currentStrategyDraftVersionId} = ${operation.baseStrategyDraftVersionId}
              and ${userBooks.currentTrialRevisionId} is null
              and ${userBooks.adjustmentCount} < ${ADJUSTMENT_LIMIT}
              and ${strategyDraftVersions.status} in ('draft', 'approved_for_trial')
          )`
        : sql`exists (
            select 1
            from ${userBooks}
            inner join ${trialRevisions}
              on ${trialRevisions.id} = ${userBooks.currentTrialRevisionId}
            where ${userBooks.id} = ${operation.userBookId}
              and ${userBooks.workflowStatus} = 'trial_review'
              and ${userBooks.currentStrategyDraftVersionId} = ${operation.baseStrategyDraftVersionId}
              and ${userBooks.currentTrialRevisionId} = ${operation.baseTrialRevisionId}
              and ${userBooks.adjustmentCount} < ${ADJUSTMENT_LIMIT}
              and ${trialRevisions.status} = 'published'
          )`;
    const [claimed] = await db
      .update(readingSetupOperations)
      .set({
        status: 'running',
        attemptCount,
        leaseId,
        leaseClaimedAt: sql`now()`,
        leaseExpiresAt: sql`now() + ${READING_SETUP_OPERATION_LEASE_SQL}`,
        resultStrategyDraftVersionId: null,
        resultTrialRevisionId: null,
        errorSummary: null,
        completedAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(readingSetupOperations.id, operation.id),
        eq(readingSetupOperations.attemptCount, operation.attemptCount),
        stateGate,
        or(
          eq(readingSetupOperations.status, 'pending'),
          eq(readingSetupOperations.status, 'failed'),
          and(
            eq(readingSetupOperations.status, 'running'),
            sql`${readingSetupOperations.leaseExpiresAt} <= now()`,
          ),
        ),
      ))
      .returning({ id: readingSetupOperations.id });
    if (!claimed) {
      const latest = await observeOperationById(operation.userBookId, operation.id);
      if (
        latest
        && latest.operation.status === operation.status
        && latest.operation.attemptCount === operation.attemptCount
        && latest.operation.leaseId === operation.leaseId
      ) {
        await validateReadingSetupOperation(operation);
      }
      throw new ReadingSetupClaimConflictError();
    }
    return { operationId: operation.id, leaseId, attemptCount };
  };

  const waitForReadingSetupOperationOutcome = async (
    operation: ReadingSetupOperationRow,
  ): Promise<ReadingSetupOperationObservation> => {
    for (;;) {
      const observed = await observeOperationById(operation.userBookId, operation.id);
      if (!observed) throw new UserBookError('阅读准备操作不存在', 404);
      if (
        observed.operation.status === 'completed'
        || observed.operation.status === 'failed'
        || (observed.operation.status === 'running' && observed.leaseExpired)
      ) {
        return observed;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  const failUnclaimedReadingSetupOperation = async (
    operation: ReadingSetupOperationRow,
    error: unknown,
  ) => {
    if (operation.status !== 'pending') return;
    const errorSummary = error instanceof UserBookError
      ? error.message
      : '阅读准备操作无法开始';
    await db
      .update(readingSetupOperations)
      .set({
        status: 'failed',
        errorSummary,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(readingSetupOperations.id, operation.id),
        eq(readingSetupOperations.status, 'pending'),
        eq(readingSetupOperations.attemptCount, operation.attemptCount),
        isNull(readingSetupOperations.leaseId),
      ));
  };

  const prepareReadingSetupOperationExecution = async (
    initial: ReadingSetupOperationRow,
    waitForClaimConflict = true,
  ): Promise<PreparedReadingSetupOperation> => {
    let operation = initial;
    let observedInFlight = false;
    if (operation.status === 'running') {
      observedInFlight = true;
      operation = (await waitForReadingSetupOperationOutcome(operation)).operation;
    }
    if (operation.status === 'completed' || (operation.status === 'failed' && observedInFlight)) {
      return { operation, claim: null };
    }
    try {
      return { operation, claim: await claimReadingSetupOperation(operation) };
    } catch (error) {
      if (!(error instanceof ReadingSetupClaimConflictError)) {
        await failUnclaimedReadingSetupOperation(operation, error).catch(() => {});
        throw error;
      }
      if (!waitForClaimConflict) {
        const observed = await observeOperationById(operation.userBookId, operation.id);
        if (!observed) throw new UserBookError('阅读准备操作不存在', 404);
        if (observed.operation.status === 'completed' || observed.operation.status === 'failed') {
          return { operation: observed.operation, claim: null };
        }
        if (observed.operation.status === 'running' && !observed.leaseExpired) {
          throw new UserBookError('阅读准备操作仍在处理中，请查询恢复状态', 409);
        }
        return prepareReadingSetupOperationExecution(observed.operation, false);
      }
      const settled = await waitForReadingSetupOperationOutcome(operation);
      if (settled.operation.status === 'completed' || settled.operation.status === 'failed') {
        return { operation: settled.operation, claim: null };
      }
      return prepareReadingSetupOperationExecution(settled.operation, true);
    }
  };

  const renewReadingSetupOperation = async (claim: ReadingSetupOperationClaim) => {
    const [renewed] = await db
      .update(readingSetupOperations)
      .set({
        leaseExpiresAt: sql`now() + ${READING_SETUP_OPERATION_LEASE_SQL}`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(readingSetupOperations.id, claim.operationId),
        eq(readingSetupOperations.status, 'running'),
        eq(readingSetupOperations.leaseId, claim.leaseId),
        eq(readingSetupOperations.attemptCount, claim.attemptCount),
        sql`${readingSetupOperations.leaseExpiresAt} > now()`,
      ))
      .returning({ id: readingSetupOperations.id });
    return Boolean(renewed);
  };

  const startOperationLeaseRenewal = (claim: ReadingSetupOperationClaim) => {
    let stopped = false;
    let lost = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (stopped) return;
        try {
          lost = !(await renewReadingSetupOperation(claim));
        } catch {
          lost = true;
        }
        if (!lost && !stopped) schedule();
      }, READING_SETUP_OPERATION_RENEW_INTERVAL_MS);
      timer.unref?.();
    };
    schedule();
    return {
      assertActive() {
        if (lost) throw new ReadingSetupLeaseLostError();
      },
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  };

  const failReadingSetupOperation = async (
    claim: ReadingSetupOperationClaim,
    error: unknown,
  ) => {
    const rawSummary = error instanceof UserBookError
      ? error.message
      : '阅读准备操作失败';
    const errorSummary = rawSummary.trim() || '阅读准备操作失败';
    const [failed] = await db
      .update(readingSetupOperations)
      .set({
        status: 'failed',
        leaseId: null,
        leaseClaimedAt: null,
        leaseExpiresAt: null,
        resultStrategyDraftVersionId: null,
        resultTrialRevisionId: null,
        errorSummary,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(readingSetupOperations.id, claim.operationId),
        eq(readingSetupOperations.status, 'running'),
        eq(readingSetupOperations.leaseId, claim.leaseId),
        eq(readingSetupOperations.attemptCount, claim.attemptCount),
        sql`${readingSetupOperations.leaseExpiresAt} > now()`,
      ))
      .returning({ id: readingSetupOperations.id });
    return Boolean(failed);
  };

  const projectReadingSetupOperation = (
    operation: ReadingSetupOperationRow,
    leaseExpired = false,
  ): ReadingSetupOperationResponse => {
    const common = {
      operationId: operation.id,
      operationAttempt: operation.attemptCount,
      baseDraftId: operation.baseStrategyDraftVersionId,
      canResume: operation.status === 'pending' || (
        operation.status === 'running' && leaseExpired
      ),
    };
    if (
      operation.kind === 'trial_selection'
      && operation.source === 'strategy_approve'
      && operation.payload.source === 'strategy_approve'
      && operation.baseTrialRevisionId === null
    ) {
      const identity = {
        ...common,
        kind: 'trial_selection' as const,
        source: 'strategy_approve' as const,
        baseTrialRevisionId: null,
      };
      if (operation.status === 'completed' && operation.resultTrialRevisionId) {
        return {
          ...identity,
          status: 'completed',
          resultDraftId: null,
          resultTrialRevisionId: operation.resultTrialRevisionId,
          errorSummary: null,
          recoverableInput: null,
        };
      }
      if (operation.status === 'failed' && operation.errorSummary) {
        return {
          ...identity,
          status: 'failed',
          resultDraftId: null,
          resultTrialRevisionId: null,
          errorSummary: operation.errorSummary,
          recoverableInput: null,
        };
      }
      if (operation.status === 'pending' || operation.status === 'running') {
        return {
          ...identity,
          status: operation.status,
          resultDraftId: null,
          resultTrialRevisionId: null,
          errorSummary: null,
          recoverableInput: null,
        };
      }
      throw new UserBookError('阅读准备操作结果损坏', 409);
    }

    if (
      operation.kind === 'strategy_revision'
      && operation.source === operation.payload.source
      && operation.payload.source !== 'strategy_approve'
      && (
        (operation.source === 'strategy_feedback' && operation.baseTrialRevisionId === null)
        || (operation.source === 'trial_feedback' && operation.baseTrialRevisionId !== null)
      )
    ) {
      const identity = operation.source === 'strategy_feedback'
        ? {
            ...common,
            kind: 'strategy_revision' as const,
            source: 'strategy_feedback' as const,
            baseTrialRevisionId: null,
          }
        : {
            ...common,
            kind: 'strategy_revision' as const,
            source: 'trial_feedback' as const,
            baseTrialRevisionId: operation.baseTrialRevisionId!,
          };
      if (operation.status === 'completed' && operation.resultStrategyDraftVersionId) {
        return {
          ...identity,
          status: 'completed',
          resultDraftId: operation.resultStrategyDraftVersionId,
          resultTrialRevisionId: null,
          errorSummary: null,
          recoverableInput: null,
        };
      }
      if (operation.status === 'failed' && operation.errorSummary) {
        return {
          ...identity,
          status: 'failed',
          resultDraftId: null,
          resultTrialRevisionId: null,
          errorSummary: operation.errorSummary,
          recoverableInput: { feedback: operation.payload.feedback },
        };
      }
      if (operation.status === 'pending' || operation.status === 'running') {
        return {
          ...identity,
          status: operation.status,
          resultDraftId: null,
          resultTrialRevisionId: null,
          errorSummary: null,
          recoverableInput: { feedback: operation.payload.feedback },
        };
      }
    }
    throw new UserBookError('阅读准备操作结果损坏', 409);
  };

  const currentReadingSetupOperation = async (userBookId: string) => {
    const owned = await getOwnedBook(userBookId);
    if (![
      'strategy_review',
      'trial_generating',
      'trial_generation_failed',
      'trial_review',
    ].includes(owned.userBook.workflowStatus)) {
      return null;
    }
    const observations = await db
      .select({
        operation: readingSetupOperations,
        leaseExpired: sql<boolean>`coalesce(${readingSetupOperations.leaseExpiresAt} <= now(), false)`,
      })
      .from(readingSetupOperations)
      .where(eq(readingSetupOperations.userBookId, userBookId))
      .orderBy(desc(readingSetupOperations.updatedAt), desc(readingSetupOperations.id));
    const active = observations.find(({ operation }) => ['pending', 'running'].includes(operation.status));
    if (active) return projectReadingSetupOperation(active.operation, active.leaseExpired);

    const current = owned.userBook.workflowStatus === 'strategy_review'
      ? observations.find(({ operation }) => (
          operation.status === 'completed'
          && operation.resultStrategyDraftVersionId === owned.userBook.currentStrategyDraftVersionId
        ) || (
          operation.status === 'failed'
          && operation.baseStrategyDraftVersionId === owned.userBook.currentStrategyDraftVersionId
          && operation.baseTrialRevisionId === null
        ))
      : observations.find(({ operation }) => (
          operation.status === 'completed'
          && operation.resultTrialRevisionId === owned.userBook.currentTrialRevisionId
        ) || (
          operation.status === 'failed'
          && operation.baseTrialRevisionId === owned.userBook.currentTrialRevisionId
        ));
    return current ? projectReadingSetupOperation(current.operation, current.leaseExpired) : null;
  };

  const shelfItem = (row: { userBook: typeof userBooks.$inferSelect; sharedBook: typeof sharedBooks.$inferSelect }): UserBookShelfItem => ({
    id: row.userBook.id,
    sharedBookId: row.sharedBook.id,
    sharedBookStatus: row.sharedBook.status,
    workflowStatus: row.userBook.workflowStatus,
    title: row.sharedBook.title,
    authors: row.sharedBook.authors,
    coverPath: row.sharedBook.coverPath,
    errorSummary: row.sharedBook.errorSummary,
    failureType: row.sharedBook.failureType,
    progress: null,
    lastActivityAt: row.userBook.updatedAt.toISOString(),
  });

  const getReaderProfile = async (userId: string) => {
    const [row] = await db
      .select({ version: readerProfileVersions })
      .from(readerProfiles)
      .innerJoin(readerProfileVersions, eq(readerProfileVersions.id, readerProfiles.currentVersionId))
      .where(eq(readerProfiles.userId, userId))
      .limit(1);
    if (!row) throw new UserBookError('长期画像不存在', 409);
    return row.version;
  };

  const getSetupContext = async (userBookId: string) => {
    const owned = await getOwnedBook(userBookId);
    const [readerProfile, bookProfile, messages] = await Promise.all([
      getReaderProfile(userId),
      options.books.getProfile(owned.sharedBook.id),
      owned.userBook.currentInterviewSessionId
        ? db
            .select()
            .from(interviewMessages)
            .where(eq(interviewMessages.interviewSessionId, owned.userBook.currentInterviewSessionId))
            .orderBy(asc(interviewMessages.sequence))
        : Promise.resolve([]),
    ]);
    if (!bookProfile) throw new UserBookError('共享书籍画像不存在', 409);
    return {
      owned,
      readerProfile,
      context: {
        book: {
          id: owned.sharedBook.id,
          title: owned.sharedBook.title,
          authors: owned.sharedBook.authors,
          language: owned.sharedBook.language,
        },
        bookProfile,
        readerProfile: readerProfile.profile,
        messages: messages.map((message) => ({
          role: message.role,
          kind: message.kind,
          content: message.content,
          payload: message.payload,
        })),
      },
    };
  };

  const emptyTurnLease = {
    turnLeaseId: null,
    turnLeaseVersion: null,
    turnLeaseClaimedAt: null,
    turnLeaseExpiresAt: null,
  } as const;

  const claimInterviewTurn = async (sessionId: string): Promise<InterviewTurnClaim | null> => {
    const leaseId = randomUUID();
    const [claimed] = await db
      .update(interviewSessions)
      .set({
        turnLeaseId: leaseId,
        turnLeaseVersion: sql`${interviewSessions.conversationVersion}`,
        turnLeaseClaimedAt: sql`now()`,
        turnLeaseExpiresAt: sql`now() + ${INTERVIEW_TURN_LEASE_SQL}`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(interviewSessions.id, sessionId),
        eq(interviewSessions.status, 'active'),
        sql`${interviewSessions.conversationVersion} = ${interviewSessions.questionCount} * 2`,
        or(
          isNull(interviewSessions.turnLeaseId),
          sql`${interviewSessions.turnLeaseExpiresAt} <= now()`,
        ),
      ))
      .returning({
        sessionId: interviewSessions.id,
        questionCount: interviewSessions.questionCount,
        conversationVersion: interviewSessions.conversationVersion,
      });
    return claimed ? { ...claimed, leaseId } : null;
  };

  const releaseInterviewTurn = async (claim: InterviewTurnClaim) => {
    await db
      .update(interviewSessions)
      .set({ ...emptyTurnLease, updatedAt: new Date() })
      .where(and(
        eq(interviewSessions.id, claim.sessionId),
        eq(interviewSessions.turnLeaseId, claim.leaseId),
        eq(interviewSessions.turnLeaseVersion, claim.conversationVersion),
      ));
  };

  const renewInterviewTurn = async (claim: InterviewTurnClaim) => {
    const [renewed] = await db
      .update(interviewSessions)
      .set({
        turnLeaseExpiresAt: sql`now() + ${INTERVIEW_TURN_LEASE_SQL}`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(interviewSessions.id, claim.sessionId),
        eq(interviewSessions.status, 'active'),
        eq(interviewSessions.turnLeaseId, claim.leaseId),
        eq(interviewSessions.turnLeaseVersion, claim.conversationVersion),
        sql`${interviewSessions.turnLeaseExpiresAt} > now()`,
      ))
      .returning({ id: interviewSessions.id });
    return Boolean(renewed);
  };

  const startInterviewTurnLeaseRenewal = (claim: InterviewTurnClaim) => {
    let stopped = false;
    let lost = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (stopped) return;
        try {
          lost = !(await renewInterviewTurn(claim));
        } catch {
          lost = true;
        }
        if (!lost && !stopped) schedule();
      }, INTERVIEW_TURN_RENEW_INTERVAL_MS);
      timer.unref?.();
    };
    schedule();
    return {
      assertActive() {
        if (lost) throw new InterviewTurnLeaseLostError();
      },
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  };

  const saveSetupOutcome = async (
    userBookId: string,
    outcome: Awaited<ReturnType<ReadingSetupEngine['runTurn']>>,
    claim: InterviewTurnClaim,
  ) => {
    if (outcome.type === 'question') {
      const committed = await db.transaction(async (tx) => {
        const sequence = claim.conversationVersion + 1;
        const advanced = await tx
          .update(interviewSessions)
          .set({
            questionCount: claim.questionCount + 1,
            conversationVersion: sequence,
            ...emptyTurnLease,
            updatedAt: new Date(),
          })
          .where(and(
            eq(interviewSessions.id, claim.sessionId),
            eq(interviewSessions.status, 'active'),
            eq(interviewSessions.questionCount, claim.questionCount),
            eq(interviewSessions.conversationVersion, claim.conversationVersion),
            eq(interviewSessions.turnLeaseId, claim.leaseId),
            eq(interviewSessions.turnLeaseVersion, claim.conversationVersion),
            sql`${interviewSessions.turnLeaseExpiresAt} > now()`,
          ))
          .returning({ id: interviewSessions.id });
        if (advanced.length !== 1) return false;
        await tx.insert(interviewMessages).values({
          interviewSessionId: claim.sessionId,
          sequence,
          role: 'assistant',
          kind: 'question',
          content: outcome.question.prompt,
          payload: mapQuestion(outcome.question),
        });
        return true;
      });
      return { committed };
    }
    if (outcome.type !== 'completed') throw new Error('unexpected reading setup outcome during interview');
    const draftId = await db.transaction(async (tx) => {
      const completed = await tx
        .update(interviewSessions)
        .set({
          status: 'completed',
          completedAt: new Date(),
          ...emptyTurnLease,
          updatedAt: new Date(),
        })
        .where(and(
          eq(interviewSessions.id, claim.sessionId),
          eq(interviewSessions.status, 'active'),
          eq(interviewSessions.questionCount, claim.questionCount),
          eq(interviewSessions.conversationVersion, claim.conversationVersion),
          eq(interviewSessions.turnLeaseId, claim.leaseId),
          eq(interviewSessions.turnLeaseVersion, claim.conversationVersion),
          sql`${interviewSessions.turnLeaseExpiresAt} > now()`,
        ))
        .returning({ id: interviewSessions.id });
      if (completed.length !== 1) return null;
      const [profile] = await tx
        .insert(bookReaderProfileVersions)
        .values({
          userBookId,
          interviewSessionId: claim.sessionId,
          version: 1,
          profile: mapBookReaderProfile(outcome.bookReaderProfile),
        })
        .returning();
      if (!profile) throw new Error('failed to save book reader profile');
      const [draft] = await tx
        .insert(strategyDraftVersions)
        .values({
          userBookId,
          bookReaderProfileVersionId: profile.id,
          version: 1,
          status: 'draft',
          readingBriefing: mapBriefing(outcome.briefing),
          userFacingSummary: outcome.publicStrategy,
          strategy: mapStrategy(outcome.strategy),
        })
        .returning();
      if (!draft) throw new Error('failed to save strategy draft');
      if (outcome.readerProfilePatch) {
        const [reader] = await tx
          .select({ profile: readerProfiles, version: readerProfileVersions })
          .from(readerProfiles)
          .innerJoin(readerProfileVersions, eq(readerProfileVersions.id, readerProfiles.currentVersionId))
          .where(eq(readerProfiles.userId, (await tx.select({ userId: userBooks.userId }).from(userBooks).where(eq(userBooks.id, userBookId)).limit(1))[0]!.userId))
          .limit(1);
        if (reader) {
          const nextProfile = applyReaderProfilePatch(reader.version.profile, outcome.readerProfilePatch);
          const [nextVersion] = await tx.insert(readerProfileVersions).values({
            readerProfileId: reader.profile.id,
            version: reader.version.version + 1,
            profile: nextProfile,
            changeSource: 'interview',
          }).returning();
          if (nextVersion) {
            await tx.update(readerProfiles).set({ currentVersionId: nextVersion.id, updatedAt: new Date() }).where(eq(readerProfiles.id, reader.profile.id));
          }
        }
      }
      // §6.5 guard: the session active→completed flip above already serializes completion, so
      // the book is invariably 'interviewing' here — assert it instead of blind-writing by id,
      // so an impossible stray state surfaces rather than silently diverging from the session.
      const activated = await tx
        .update(userBooks)
        .set({
          workflowStatus: 'strategy_review',
          currentBookReaderProfileVersionId: profile.id,
          currentStrategyDraftVersionId: draft.id,
          updatedAt: new Date(),
        })
        .where(and(eq(userBooks.id, userBookId), eq(userBooks.workflowStatus, 'interviewing')))
        .returning({ id: userBooks.id });
      if (activated.length !== 1) throw new UserBookError('访谈状态已经变化', 409);
      return draft.id;
    });
    return { committed: draftId !== null, ...(draftId ? { draftId } : {}) };
  };

  const createReadingNodeProjector = (
    manifest: ReadingManifest,
    bookProfileValue: unknown,
  ) => {
    const allowedCandidates = new Set(
      ((bookProfileValue as { trial_candidates?: Array<{ section_id: string; segment: number }> } | null)
        ?.trial_candidates ?? [])
        .map((candidate) => `${candidate.section_id}:${candidate.segment}`),
    );
    return (
      candidate: { ordinal: number; sectionId: string; segment: number; reason: string },
      seen: Set<string>,
    ): ReadingNodePreview => {
      const key = `${candidate.sectionId}:${candidate.segment}`;
      const node = manifest.nodes.find(
        (item) => item.section_id === candidate.sectionId && item.segment === candidate.segment,
      );
      if (
        candidate.ordinal < 1
        || candidate.ordinal > 3
        || !node?.tailoring_eligible
        || !allowedCandidates.has(key)
        || seen.has(key)
      ) {
        throw new UserBookError('访谈生成了无效的试读候选', 409);
      }
      seen.add(key);
      return {
        ordinal: candidate.ordinal,
        sectionId: candidate.sectionId,
        segment: candidate.segment,
        chapterPath: chapterPath(node, manifest.outline),
        reason: candidate.reason,
      };
    };
  };

  // Runs one claimed interviewing turn (agent → next question or finish) and fences the
  // commit with the lease token. The model call never holds a database transaction open.
  const generateNextQuestion = async (
    userBookId: string,
    claim: InterviewTurnClaim,
    onStream?: (delta: InterviewTurnStreamDelta) => void,
  ) => {
    const lease = startInterviewTurnLeaseRenewal(claim);
    try {
      const setup = await getSetupContext(userBookId);
      const manifestValue = await options.books.getManifest(setup.owned.sharedBook.id);
      if (!manifestValue) throw new UserBookError('书籍阅读索引不存在', 409);
      const manifest = asManifest(manifestValue);
      const projectNode = createReadingNodeProjector(manifest, setup.context.bookProfile);
      let streamedEpoch = 0;
      let streamedNodes = new Set<string>();
      const outcome = await options.setupEngine.runTurn({
        sessionId: claim.sessionId,
        phase: 'interviewing',
        askedCount: claim.questionCount,
        conversationVersion: claim.conversationVersion,
        context: setup.context,
        ...(requestContext.requestId ? { requestId: requestContext.requestId } : {}),
        ...(onStream ? {
          onStream: (delta: ReadingSetupStreamDelta) => {
            lease.assertActive();
            // `concluding` is held until the authoritative transaction commits.
            if (delta.type === 'concluding') return;
            if (delta.type === 'speculative_reset') {
              streamedEpoch = delta.speculativeEpoch;
              streamedNodes = new Set<string>();
              onStream(delta);
              return;
            }
            if (delta.speculativeEpoch < streamedEpoch) return;
            if (delta.type === 'reading_node_added') {
              try {
                onStream({
                  type: 'reading_node_added',
                  speculativeEpoch: delta.speculativeEpoch,
                  node: projectNode(delta, streamedNodes),
                });
              } catch (error) {
                if (!(error instanceof UserBookError)) throw error;
              }
              return;
            }
            onStream(delta);
          },
        } : {}),
      });
      lease.assertActive();
      if (outcome.type === 'completed') {
        const finalNodes = new Set<string>();
        outcome.strategy.trial_candidates.forEach((candidate, index) => projectNode({
          ordinal: index + 1,
          sectionId: candidate.section_id,
          segment: candidate.segment,
          reason: candidate.reason,
        }, finalNodes));
      }
      const saved = await saveSetupOutcome(userBookId, outcome, claim);
      if (!saved.committed) throw new InterviewTurnLeaseLostError();
      return { outcome, ...saved };
    } catch (error) {
      try {
        await releaseInterviewTurn(claim);
      } catch {
        // The lease expiry is the crash-safe fallback when an explicit release also fails.
      }
      throw error;
    } finally {
      lease.stop();
    }
  };

  const ensureInterviewSession = async (userBookId: string) => {
    const owned = await getOwnedBook(userBookId);
    if (owned.sharedBook.status !== 'ready') throw new UserBookError('书籍尚未处理完成', 409);
    if (!['on_shelf', 'interviewing'].includes(owned.userBook.workflowStatus)) {
      throw new UserBookError('当前阶段不能开始访谈', 409);
    }
    let sessionId = owned.userBook.currentInterviewSessionId;
    if (!sessionId) {
      await db.insert(interviewSessions).values({ userBookId }).onConflictDoNothing({ target: interviewSessions.userBookId });
      const [session] = await db.select().from(interviewSessions).where(eq(interviewSessions.userBookId, userBookId)).limit(1);
      if (!session) throw new UserBookError('访谈初始化失败', 503);
      sessionId = session.id;
      // §6.5 guard: only start interviewing from the two valid prior states (checked above).
      // A concurrent advance makes this a no-op; the next call re-links the session (self-heal).
      await db
        .update(userBooks)
        .set({ workflowStatus: 'interviewing', currentInterviewSessionId: session.id, updatedAt: new Date() })
        .where(and(
          eq(userBooks.id, userBookId),
          inArray(userBooks.workflowStatus, ['on_shelf', 'interviewing']),
        ));
    }
    return sessionId;
  };

  const resumePendingInterviewTurn = async (
    userBookId: string,
    sessionId: string,
  ) => {
    const claim = await claimInterviewTurn(sessionId);
    if (!claim) return false;
    await generateNextQuestion(userBookId, claim);
    return true;
  };

  // Read-only projection of the persisted interview. Generation is owned exclusively by the
  // explicit start/resume commands and the answer transaction's leased turn.
  const readInterviewState = async (userBookId: string): Promise<InterviewStateResponse> => {
    const owned = await getOwnedBook(userBookId);
    const sessionId = owned.userBook.currentInterviewSessionId;
    if (!sessionId) throw new UserBookError('访谈尚未建立', 409);
    const [session, messages, answers] = await Promise.all([
      db.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId)).limit(1).then((rows) => rows[0]),
      db.select().from(interviewMessages).where(eq(interviewMessages.interviewSessionId, sessionId)).orderBy(asc(interviewMessages.sequence)),
      db.select({ answer: interviewAnswers, question: interviewMessages })
        .from(interviewAnswers)
        .innerJoin(interviewMessages, eq(interviewMessages.id, interviewAnswers.questionMessageId))
        .where(eq(interviewAnswers.interviewSessionId, sessionId))
        .orderBy(asc(interviewAnswers.createdAt)),
    ]);
    if (!session) throw new UserBookError('访谈不存在', 404);
    const answeredQuestionIds = new Set(answers.map((row) => String(row.question.payload.id ?? '')));
    const currentMessage = [...messages]
      .reverse()
      .find((message) => message.kind === 'question' && !answeredQuestionIds.has(String(message.payload.id ?? '')));
    return {
      sessionId,
      status: session.status,
      turnInProgress: Boolean(
        session.turnLeaseId
        && session.turnLeaseExpiresAt
        && session.turnLeaseExpiresAt.getTime() > Date.now()
      ),
      questionCount: session.questionCount,
      maxQuestions: 7,
      currentQuestion: currentMessage ? currentMessage.payload as InterviewQuestion : null,
      sufficiency: currentMessage
        ? (currentMessage.payload as { sufficiency?: number }).sufficiency ?? null
        : null,
      answers: answers.map(({ answer, question }) => {
        // Resolve the human-readable history row from the joined question payload — the raw
        // answer only stores option ids and free text, so without this the client can only
        // show placeholders ("第 N 问") and opaque option slugs ("understand").
        const payload = question.payload as InterviewQuestion;
        const labels = answer.selectedOptionIds
          .map((id) => payload.options?.find((option) => option.id === id)?.label ?? id);
        const answerText = [...labels, answer.freeText?.trim()].filter(Boolean).join('；');
        return {
          id: answer.id,
          questionId: String(payload.id ?? ''),
          question: payload.prompt ?? '',
          selectedOptionIds: answer.selectedOptionIds,
          freeText: answer.freeText,
          answerText,
          createdAt: answer.createdAt.toISOString(),
        };
      }),
    };
  };

  const interviewState = readInterviewState;

  // Persists one answer and atomically leases the following model turn. Locking the session
  // serializes different idempotency keys for the same question before either can call the model.
  const commitInterviewAnswer = async (
    userBookId: string,
    input: SubmitInterviewAnswerRequest,
  ): Promise<{ inserted: boolean; sessionId: string; claim?: InterviewTurnClaim }> => {
    const owned = await getOwnedBook(userBookId);
    const sessionId = owned.userBook.currentInterviewSessionId;
    if (owned.userBook.workflowStatus !== 'interviewing' || !sessionId) {
      throw new UserBookError('当前没有可回答的问题', 409);
    }
    const normalizedFreeText = input.freeText?.trim() || null;
    const selected = new Set(input.selectedOptionIds);
    return db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(interviewSessions)
        .where(eq(interviewSessions.id, sessionId))
        .limit(1)
        .for('update');
      if (!session || session.status !== 'active') throw new UserBookError('访谈状态已经变化', 409);

      const [existing] = await tx
        .select()
        .from(interviewAnswers)
        .where(and(eq(interviewAnswers.interviewSessionId, sessionId), eq(interviewAnswers.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (existing) {
        const [existingQuestion] = await tx
          .select()
          .from(interviewMessages)
          .where(eq(interviewMessages.id, existing.questionMessageId))
          .limit(1);
        if (
          String(existingQuestion?.payload.id ?? '') !== input.questionId
          || !isDeepStrictEqual(existing.selectedOptionIds, input.selectedOptionIds)
          || existing.freeText !== normalizedFreeText
        ) {
          throw new UserBookError('幂等键已用于不同的访谈回答', 409);
        }
        return { inserted: false, sessionId };
      }

      const [questionMessage] = await tx
        .select()
        .from(interviewMessages)
        .where(and(
          eq(interviewMessages.interviewSessionId, sessionId),
          eq(interviewMessages.kind, 'question'),
        ))
        .orderBy(desc(interviewMessages.sequence))
        .limit(1);
      if (
        !questionMessage
        || questionMessage.sequence !== session.conversationVersion
        || String(questionMessage.payload.id ?? '') !== input.questionId
      ) {
        throw new UserBookError('问题已经更新，请刷新后继续', 409);
      }
      const [answered] = await tx
        .select({ id: interviewAnswers.id })
        .from(interviewAnswers)
        .where(eq(interviewAnswers.questionMessageId, questionMessage.id))
        .limit(1);
      if (answered) throw new UserBookError('问题已经回答，请刷新后继续', 409);

      const question = questionMessage.payload as unknown as InterviewQuestion;
      if (input.selectedOptionIds.some((id) => !question.options.some((option) => option.id === id))) {
        throw new UserBookError('回答包含无效选项', 400);
      }
      if (selected.size === 0 && !normalizedFreeText) {
        throw new UserBookError('请选择一个选项或填写补充内容', 400);
      }

      await tx.insert(interviewAnswers).values({
        interviewSessionId: sessionId,
        questionMessageId: questionMessage.id,
        selectedOptionIds: input.selectedOptionIds,
        freeText: normalizedFreeText,
        idempotencyKey: input.idempotencyKey,
      });
      const labels = question.options.filter((option) => selected.has(option.id)).map((option) => option.label);
      const content = [...labels, normalizedFreeText].filter(Boolean).join('；');
      const conversationVersion = session.conversationVersion + 1;
      await tx.insert(interviewMessages).values({
        interviewSessionId: sessionId,
        sequence: conversationVersion,
        role: 'user',
        kind: 'answer',
        content,
        payload: input,
      });
      const leaseId = randomUUID();
      await tx
        .update(interviewSessions)
        .set({
          conversationVersion,
          turnLeaseId: leaseId,
          turnLeaseVersion: conversationVersion,
          turnLeaseClaimedAt: sql`now()`,
          turnLeaseExpiresAt: sql`now() + ${INTERVIEW_TURN_LEASE_SQL}`,
          updatedAt: new Date(),
        })
        .where(eq(interviewSessions.id, sessionId));
      return {
        inserted: true,
        sessionId,
        claim: {
          sessionId,
          leaseId,
          questionCount: session.questionCount,
          conversationVersion,
        },
      };
    });
  };

  const createInterviewStreamEmitter = (userBookId: string, streamId: string) => {
    let sequence = 0;
    return (payload: InterviewStreamPayload): InterviewStreamEvent => ({
      userBookId,
      streamId,
      sequence: sequence += 1,
      ...payload,
    } as InterviewStreamEvent);
  };

  // Closes a streamed turn from persisted state so question/final pointers remain authoritative.
  const terminalInterviewEvents = async function* (
    userBookId: string,
    emit: (payload: InterviewStreamPayload) => InterviewStreamEvent,
  ): AsyncGenerator<InterviewStreamEvent> {
    const owned = await getOwnedBook(userBookId);
    if (owned.userBook.workflowStatus !== 'interviewing') {
      yield emit({ type: 'done', workflowStatus: owned.userBook.workflowStatus });
      return;
    }
    const state = await readInterviewState(userBookId);
    if (state.currentQuestion) {
      yield emit({
        type: 'question_final',
        question: state.currentQuestion,
        ordinal: Math.max(1, Math.min(state.maxQuestions, state.questionCount)),
        maxQuestions: state.maxQuestions,
      });
    } else {
      // No question yet (a concurrent turn, or a turn that produced nothing) — tell the client
      // to fall back to GET /interview.
      yield emit({ type: 'done', workflowStatus: owned.userBook.workflowStatus });
    }
  };

  const strategyStateByDraftId = async (
    userBookId: string,
    draftId: string,
  ): Promise<StrategyReviewResponse> => {
    const owned = await getOwnedBook(userBookId);
    const [draft, manifestValue] = await Promise.all([
      db
        .select()
        .from(strategyDraftVersions)
        .where(and(
          eq(strategyDraftVersions.id, draftId),
          eq(strategyDraftVersions.userBookId, userBookId),
        ))
        .limit(1)
        .then((rows) => rows[0]),
      options.books.getManifest(owned.sharedBook.id),
    ]);
    if (!draft) throw new UserBookError('处理方式版本不存在', 404);
    if (!manifestValue) throw new UserBookError('书籍阅读索引不存在', 409);
    const manifest = asManifest(manifestValue);
    const trialCandidatePreviews = draft.strategy.trialCandidates.map((candidate, index) => {
      const node = manifest.nodes.find(
        (item) => item.section_id === candidate.sectionId && item.segment === candidate.segment,
      );
      if (!node) throw new UserBookError('处理方式引用的试读候选不存在', 409);
      return {
        ordinal: index + 1,
        sectionId: candidate.sectionId,
        segment: candidate.segment,
        chapterPath: chapterPath(node, manifest.outline),
        reason: candidate.reason,
      };
    });
    const isCurrent = owned.userBook.workflowStatus === 'strategy_review'
      && owned.userBook.currentStrategyDraftVersionId === draft.id;
    return {
      userBookId,
      workflowStatus: owned.userBook.workflowStatus,
      draft: {
        id: draft.id,
        version: draft.version,
        status: draft.status,
        readingBriefing: draft.readingBriefing,
        userFacingSummary: draft.userFacingSummary,
        strategy: draft.strategy,
        createdAt: draft.createdAt.toISOString(),
        approvedForTrialAt: draft.approvedForTrialAt?.toISOString() ?? null,
      },
      trialCandidatePreviews,
      adjustmentCount: owned.userBook.adjustmentCount,
      adjustmentLimit: ADJUSTMENT_LIMIT,
      canAdjust: isCurrent && owned.userBook.adjustmentCount < ADJUSTMENT_LIMIT,
    };
  };

  const strategyState = async (userBookId: string): Promise<StrategyReviewResponse> => {
    const owned = await getOwnedBook(userBookId);
    const draftId = owned.userBook.currentStrategyDraftVersionId;
    if (!draftId) throw new UserBookError('当前处理方式不存在', 409);
    return strategyStateByDraftId(userBookId, draftId);
  };

  const streamClaimedInterviewTurn = async function* (
    userBookId: string,
    claim: InterviewTurnClaim,
  ): AsyncGenerator<InterviewStreamEvent> {
    const emit = createInterviewStreamEmitter(userBookId, claim.leaseId);
    const bridge = createStreamBridge<InterviewStreamEvent>();
    let latestEpoch = 1;
    let result: Awaited<ReturnType<typeof generateNextQuestion>> | undefined;
    let turnError: unknown;
    const running = generateNextQuestion(userBookId, claim, (delta) => {
      latestEpoch = Math.max(latestEpoch, delta.speculativeEpoch);
      switch (delta.type) {
        case 'speculative_reset':
          bridge.push(emit({
            type: 'speculative_reset',
            speculativeEpoch: delta.speculativeEpoch,
            phase: 'interviewing',
          }));
          break;
        case 'ack_delta':
        case 'prompt_delta':
        case 'hint_delta':
        case 'strategy_delta':
          bridge.push(emit({
            type: delta.type,
            speculativeEpoch: delta.speculativeEpoch,
            chars: delta.chars,
          }));
          break;
        case 'option_added':
          bridge.push(emit({
            type: delta.type,
            speculativeEpoch: delta.speculativeEpoch,
            id: delta.id,
            label: delta.label,
          }));
          break;
        case 'sufficiency':
          bridge.push(emit({
            type: delta.type,
            speculativeEpoch: delta.speculativeEpoch,
            value: delta.value,
          }));
          break;
        case 'draft_started':
          if (delta.source === 'interview') {
            bridge.push(emit({
              type: delta.type,
              speculativeEpoch: delta.speculativeEpoch,
              conversationVersion: claim.conversationVersion,
            }));
          }
          break;
        case 'briefing_delta':
          bridge.push(emit({
            type: delta.type,
            speculativeEpoch: delta.speculativeEpoch,
            field: delta.field,
            chars: delta.chars,
          }));
          break;
        case 'reading_node_added':
          bridge.push(emit({
            type: delta.type,
            speculativeEpoch: delta.speculativeEpoch,
            node: delta.node,
          }));
          break;
        case 'concluding':
        case 'selection_started':
        case 'fragment_added':
          break;
      }
    })
      .then((value) => {
        result = value;
      })
      .catch((error: unknown) => {
        turnError = error;
      })
      .finally(() => bridge.end());

    for await (const event of bridge.drain()) yield event;
    await running;
    if (turnError) {
      const code: ReadingSetupStreamErrorCode = turnError instanceof InterviewTurnLeaseLostError
        ? 'lease_lost'
        : turnError instanceof UserBookError
          ? 'validation_failed'
          : 'agent_failed';
      yield emit({
        type: 'error',
        code,
        message: turnError instanceof UserBookError
          ? turnError.message
          : code === 'lease_lost'
            ? '访谈处理已由新的恢复请求接管。'
            : '生成下一步时出错，请稍后重试。',
      });
      return;
    }
    if (!result) {
      yield emit({ type: 'error', code: 'internal_error', message: '访谈处理结果缺失。' });
      return;
    }
    if (result.outcome.type === 'completed') {
      if (!result.draftId) {
        yield emit({ type: 'error', code: 'internal_error', message: '处理方式草稿结果缺失。' });
        return;
      }
      yield emit({ type: 'concluding', speculativeEpoch: latestEpoch });
      const strategy = await strategyStateByDraftId(userBookId, result.draftId);
      yield emit({ type: 'draft_final', strategy });
    }
    yield* terminalInterviewEvents(userBookId, emit);
  };

  // §6.4 / §10.7 shared revision engine. Runs the revision LLM FIRST (no writes), then applies
  // the whole change in ONE transaction: supersede the current draft, insert the revised draft,
  // record the feedback message (carrying the idempotency key) and bump the adjustment count,
  // landing the book back in strategy_review. When `trialRevisionId` is present (trial feedback,
  // §6.4) the published trial round and its generations are voided in the SAME transaction — so a
  // crash before commit leaves the trial intact and the request is simply retried, with no
  // half-applied state and no double count. Callers do their own phase-specific pre-validation.
  const reviseFromFeedback = async (
    userBookId: string,
    params: {
      draft: StrategyReviewResponse['draft'];
      feedback: string;
      idempotencyKey: string;
      trialRevisionId?: string;
      operationClaim: ReadingSetupOperationClaim;
      assertLeaseActive(): void;
      onStream?: (delta: RevisionTurnStreamDelta) => void;
    },
  ): Promise<string> => {
    const setup = await getSetupContext(userBookId);
    const manifestValue = await options.books.getManifest(setup.owned.sharedBook.id);
    if (!manifestValue) throw new UserBookError('书籍阅读索引不存在', 409);
    const projectNode = createReadingNodeProjector(
      asManifest(manifestValue),
      setup.context.bookProfile,
    );
    let streamedEpoch = 0;
    let streamedNodes = new Set<string>();
    const outcome = await options.setupEngine.runTurn({
      sessionId: setup.owned.userBook.currentInterviewSessionId!,
      phase: 'strategy_review',
      askedCount: 0,
      context: { ...setup.context, currentStrategy: params.draft },
      feedback: params.feedback,
      ...(requestContext.requestId ? { requestId: requestContext.requestId } : {}),
      ...(params.onStream ? {
        onStream: (delta: ReadingSetupStreamDelta) => {
          params.assertLeaseActive();
          if (delta.type === 'speculative_reset') {
            streamedEpoch = delta.speculativeEpoch;
            streamedNodes = new Set<string>();
            params.onStream?.(delta);
            return;
          }
          if (delta.speculativeEpoch < streamedEpoch) return;
          if (delta.type === 'draft_started' && delta.source === 'revision') {
            params.onStream?.(delta);
          } else if (delta.type === 'strategy_delta') {
            params.onStream?.(delta);
          } else if (delta.type === 'reading_node_added') {
            try {
              params.onStream?.({
                type: 'reading_node_added',
                speculativeEpoch: delta.speculativeEpoch,
                node: projectNode(delta, streamedNodes),
              });
            } catch (error) {
              if (!(error instanceof UserBookError)) throw error;
            }
          }
        },
      } : {}),
    });
    if (outcome.type !== 'revised') throw new UserBookError('处理方式修订失败', 503);
    const revised = outcome;
    const finalNodes = new Set<string>();
    revised.strategy.trial_candidates.forEach((candidate, index) => projectNode({
      ordinal: index + 1,
      sectionId: candidate.section_id,
      segment: candidate.segment,
      reason: candidate.reason,
    }, finalNodes));
    params.assertLeaseActive();
    try {
      const resultDraftId = await db.transaction(async (tx) => {
        const [bookGate] = await tx.select().from(userBooks).where(eq(userBooks.id, userBookId)).limit(1);
        if (!bookGate || bookGate.currentStrategyDraftVersionId !== params.draft.id || bookGate.adjustmentCount >= 5) {
          throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
        }
        if (params.trialRevisionId) {
          if (bookGate.workflowStatus !== 'trial_review' || bookGate.currentTrialRevisionId !== params.trialRevisionId) {
            throw new UserBookError('试读版本已经更新', 409);
          }
          const changedRevision = await tx
            .update(trialRevisions)
            .set({ status: 'superseded', supersededAt: new Date(), updatedAt: new Date() })
            .where(and(
              eq(trialRevisions.id, params.trialRevisionId),
              eq(trialRevisions.userBookId, userBookId),
              eq(trialRevisions.status, 'published'),
            ))
            .returning({ id: trialRevisions.id });
          if (changedRevision.length !== 1) throw new UserBookError('试读版本已经更新', 409);
          const sourceSegments = await tx
            .select({ id: trialSegments.id })
            .from(trialSegments)
            .where(eq(trialSegments.trialRevisionId, params.trialRevisionId));
          if (sourceSegments.length > 0) {
            await tx
              .update(nodeGenerations)
              .set({ status: 'superseded', result: null, completedAt: new Date(), updatedAt: new Date() })
              .where(and(
                eq(nodeGenerations.userBookId, userBookId),
                eq(nodeGenerations.generationScope, 'trial'),
                inArray(nodeGenerations.trialSegmentId, sourceSegments.map((segment) => segment.id)),
                inArray(nodeGenerations.status, ['queued', 'generating', 'retrying', 'ready', 'failed']),
              ));
          }
        } else if (bookGate.workflowStatus !== 'strategy_review' || bookGate.currentTrialRevisionId) {
          throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
        }
        const superseded = await tx
          .update(strategyDraftVersions)
          .set({ status: 'superseded', supersededAt: new Date() })
          .where(and(
            eq(strategyDraftVersions.id, params.draft.id),
            eq(strategyDraftVersions.userBookId, userBookId),
            eq(strategyDraftVersions.status, params.draft.status),
          ))
          .returning({ id: strategyDraftVersions.id });
        if (superseded.length !== 1) throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
        const profileId = bookGate.currentBookReaderProfileVersionId;
        if (!profileId) throw new UserBookError('本书画像不存在', 409);
        const sessionId = bookGate.currentInterviewSessionId;
        if (sessionId) {
          const [session] = await tx.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId)).limit(1);
          if (session) {
            // The feedback insert is the idempotency gate: a duplicate key collides on the
            // partial unique index and rolls the whole transaction back (caught below).
            await tx.insert(interviewMessages).values({
              interviewSessionId: sessionId,
              sequence: session.conversationVersion + 1,
              role: 'user',
              kind: 'feedback',
              content: params.feedback.trim(),
              payload: { strategyDraftVersionId: params.draft.id, feedback: params.feedback },
              idempotencyKey: params.idempotencyKey,
            });
            await tx.update(interviewSessions).set({ conversationVersion: session.conversationVersion + 1, updatedAt: new Date() }).where(eq(interviewSessions.id, sessionId));
          }
        }
        const [draft] = await tx.insert(strategyDraftVersions).values({
          userBookId,
          bookReaderProfileVersionId: profileId,
          version: params.draft.version + 1,
          status: 'draft',
          readingBriefing: params.draft.readingBriefing,
          userFacingSummary: revised.publicStrategy,
          strategy: mapStrategy(revised.strategy),
        }).returning();
        if (!draft) throw new Error('failed to save revised strategy');
        const updated = await tx
          .update(userBooks)
          .set({
            workflowStatus: 'strategy_review',
            currentStrategyDraftVersionId: draft.id,
            currentTrialRevisionId: null,
            adjustmentCount: sql`${userBooks.adjustmentCount} + 1`,
            updatedAt: new Date(),
          })
          .where(and(
            eq(userBooks.id, userBookId),
            eq(userBooks.currentStrategyDraftVersionId, params.draft.id),
            sql`${userBooks.adjustmentCount} < 5`,
          ))
          .returning({ id: userBooks.id });
        if (updated.length !== 1) throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
        const completed = await tx
          .update(readingSetupOperations)
          .set({
            status: 'completed',
            leaseId: null,
            leaseClaimedAt: null,
            leaseExpiresAt: null,
            resultStrategyDraftVersionId: draft.id,
            resultTrialRevisionId: null,
            errorSummary: null,
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(and(
            eq(readingSetupOperations.id, params.operationClaim.operationId),
            eq(readingSetupOperations.status, 'running'),
            eq(readingSetupOperations.leaseId, params.operationClaim.leaseId),
            eq(readingSetupOperations.attemptCount, params.operationClaim.attemptCount),
            sql`${readingSetupOperations.leaseExpiresAt} > now()`,
            eq(readingSetupOperations.baseStrategyDraftVersionId, params.draft.id),
            params.trialRevisionId
              ? eq(readingSetupOperations.baseTrialRevisionId, params.trialRevisionId)
              : isNull(readingSetupOperations.baseTrialRevisionId),
          ))
          .returning({ id: readingSetupOperations.id });
        if (completed.length !== 1) throw new ReadingSetupLeaseLostError();
        return draft.id;
      });
      return resultDraftId;
    } catch (error) {
      throw error;
    }
  };

  const getManifestAndHtml = async (sharedBookId: string) => {
    const [manifestValue, content] = await Promise.all([
      options.books.getManifest(sharedBookId),
      options.books.getContent(sharedBookId),
    ]);
    if (!manifestValue || !content) throw new UserBookError('书籍原文或阅读索引不存在', 409);
    return { manifest: asManifest(manifestValue), html: new TextDecoder().decode(content) };
  };

  const enqueueTrialRevisionGenerations = async (
    userBookId: string,
    trialRevisionId: string,
    generationIds: string[],
  ) => {
    try {
      await Promise.all(generationIds.map((generationId) => options.generations.enqueue({
        generationId,
        userBookId,
        scope: 'trial',
      })));
    } catch {
      await db.transaction(async (tx) => {
        const [book] = await tx
          .select()
          .from(userBooks)
          .where(eq(userBooks.id, userBookId))
          .limit(1)
          .for('update');
        const [revision] = await tx
          .select()
          .from(trialRevisions)
          .where(and(
            eq(trialRevisions.id, trialRevisionId),
            eq(trialRevisions.userBookId, userBookId),
          ))
          .limit(1)
          .for('update');
        const draft = revision
          ? await tx
              .select({ id: strategyDraftVersions.id, status: strategyDraftVersions.status })
              .from(strategyDraftVersions)
              .where(eq(strategyDraftVersions.id, revision.strategyDraftVersionId))
              .limit(1)
              .for('update')
              .then((rows) => rows[0])
          : undefined;
        const segments = revision
          ? await tx
              .select({ id: trialSegments.id })
              .from(trialSegments)
              .where(eq(trialSegments.trialRevisionId, revision.id))
              .orderBy(asc(trialSegments.ordinal))
              .for('update')
          : [];
        await tx
          .select({ id: nodeGenerations.id })
          .from(nodeGenerations)
          .where(inArray(nodeGenerations.id, generationIds))
          .for('update');
        if (
          !book
          || !revision
          || !draft
          || draft.status !== 'approved_for_trial'
          || revision.status !== 'generating'
          || revision.strategyDraftVersionId !== draft.id
          || book.workflowStatus !== 'trial_generating'
          || book.currentStrategyDraftVersionId !== draft.id
          || book.currentTrialRevisionId !== revision.id
          || segments.length !== 3
        ) return;
        const now = new Date();
        const failedGenerations = await tx.update(nodeGenerations).set({
          status: 'failed',
          result: null,
          errorSummary: '内容生成任务入队失败',
          completedAt: now,
          updatedAt: now,
        }).where(and(
          inArray(nodeGenerations.id, generationIds),
          inArray(nodeGenerations.status, ['queued', 'generating', 'retrying']),
        )).returning({ trialSegmentId: nodeGenerations.trialSegmentId });
        const failedSegmentIds = failedGenerations
          .map((generation) => generation.trialSegmentId)
          .filter((segmentId): segmentId is string => Boolean(segmentId));
        if (failedSegmentIds.length > 0) {
          await tx.update(trialSegments).set({ status: 'failed', updatedAt: now }).where(and(
            inArray(trialSegments.id, failedSegmentIds),
            inArray(trialSegments.status, ['pending', 'generating']),
          ));
        }
        const [failedRevision] = await tx
          .update(trialRevisions)
          .set({
            status: 'failed',
            failureSummary: '试读内容暂时无法开始生成，请重试。',
            failedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(trialRevisions.id, trialRevisionId),
            eq(trialRevisions.status, 'generating'),
          ))
          .returning({ id: trialRevisions.id });
        if (!failedRevision) return;
        await tx.update(userBooks).set({
          workflowStatus: 'trial_generation_failed',
          updatedAt: now,
        }).where(and(
          eq(userBooks.id, userBookId),
          eq(userBooks.workflowStatus, 'trial_generating'),
          eq(userBooks.currentTrialRevisionId, trialRevisionId),
          eq(userBooks.currentStrategyDraftVersionId, draft.id),
        ));
      }).catch(() => {});
    }
  };

  const createTrialRevision = async (
    userBookId: string,
    draftId: string,
    approveDraft = false,
    fragments?: TrialCandidate[],
    operationClaim?: ReadingSetupOperationClaim,
  ) => {
    const owned = await getOwnedBook(userBookId);
    const [draft] = await db
      .select()
      .from(strategyDraftVersions)
      .where(and(eq(strategyDraftVersions.id, draftId), eq(strategyDraftVersions.userBookId, userBookId)))
      .limit(1);
    if (!draft) throw new UserBookError('策略草稿不存在', 404);
    const [{ manifest, html }, bookProfileValue] = await Promise.all([
      getManifestAndHtml(owned.sharedBook.id),
      options.books.getProfile(owned.sharedBook.id),
    ]);
    const allowedCandidates = new Set(
      ((bookProfileValue as { trial_candidates?: Array<{ section_id: string; segment: number }> } | null)
        ?.trial_candidates ?? [])
        .map((candidate) => `${candidate.section_id}:${candidate.segment}`),
    );
    // Approve supplies freshly selected fragments (with agent ranges); retry reuses the
    // ranges persisted on the draft during the original approve — no second agent call.
    const chosen = fragments ?? draft.strategy.trialCandidates;
    const selected = chosen.map((candidate, index) => {
      const node = manifest.nodes.find(
        (item) => item.section_id === candidate.sectionId && item.segment === candidate.segment,
      );
      if (!node?.tailoring_eligible) throw new UserBookError('策略草稿引用了不可裁读的试读候选', 409);
      if (!allowedCandidates.has(`${candidate.sectionId}:${candidate.segment}`)) {
        throw new UserBookError('策略草稿引用了书籍画像候选池之外的试读位置', 409);
      }
      if (!candidate.range) throw new UserBookError('试读片段缺少范围', 409);
      const source = extractNodeSourceFromHtml(html, candidate.sectionId, candidate.segment);
      assertRangeWithinBlocks(source.blocks, candidate.range);
      const ordinal = candidate.tag === 'threshold'
        ? 1
        : candidate.tag === 'typical'
          ? 2
          : candidate.tag === 'hardest'
            ? 3
            : index + 1;
      return { candidate, node, ordinal, range: candidate.range };
    });
    if (new Set(selected.map((item) => `${item.node.section_id}:${item.node.segment}`)).size !== 3) {
      throw new UserBookError('三个试读片段必须互不重叠', 409);
    }
    const created = await db.transaction(async (tx) => {
      if (approveDraft) {
        // Persist the selected fragments onto the draft together with the status flip so a
        // later retryTrial rebuilds the same ranges from the draft without re-running select.
        const changed = await tx
          .update(strategyDraftVersions)
          .set({
            status: 'approved_for_trial',
            approvedForTrialAt: new Date(),
            ...(fragments ? { strategy: { ...draft.strategy, trialCandidates: fragments } } : {}),
          })
          .where(and(
            eq(strategyDraftVersions.id, draftId),
            eq(strategyDraftVersions.userBookId, userBookId),
            eq(strategyDraftVersions.status, 'draft'),
          ))
          .returning({ id: strategyDraftVersions.id });
        if (changed.length !== 1) throw new UserBookError('处理方式已经确认或更新', 409);
      }
      const [lastRevision] = await tx
        .select({ revision: trialRevisions.revision })
        .from(trialRevisions)
        .where(eq(trialRevisions.userBookId, userBookId))
        .orderBy(desc(trialRevisions.revision))
        .limit(1);
      const [revision] = await tx
        .insert(trialRevisions)
        .values({
          userBookId,
          strategyDraftVersionId: draftId,
          revision: (lastRevision?.revision ?? 0) + 1,
          status: 'generating',
        })
        .returning();
      if (!revision) throw new Error('failed to create trial revision');
      const generationIds: string[] = [];
      for (const item of selected) {
        const [segment] = await tx
          .insert(trialSegments)
          .values({
            trialRevisionId: revision.id,
            ordinal: item.ordinal,
            sectionId: item.node.section_id,
            segment: item.node.segment,
            startBlockIndex: item.range.start.blockIndex,
            startOffset: item.range.start.offset,
            endBlockIndex: item.range.end.blockIndex,
            endOffset: item.range.end.offset,
            selectionReason: item.candidate.reason,
            status: 'pending',
          })
          .returning();
        if (!segment) throw new Error('failed to create trial segment');
        const generationId = randomUUID();
        await tx.insert(nodeGenerations).values({
          id: generationId,
          userBookId,
          generationScope: 'trial',
          trialSegmentId: segment.id,
          strategyDraftVersionId: draftId,
          sectionId: item.node.section_id,
          segment: item.node.segment,
          status: 'queued',
          modelConfigId: options.modelConfigId,
          promptVersion: 'tailoring-content-1.0',
          cacheKey: `pending:${generationId}`,
        });
        generationIds.push(generationId);
      }
      // §6.5 guard: createTrialRevision is reachable only from strategy_review (approve) or
      // trial_generation_failed (retry); assert it so a stray state can't strand an orphan
      // generating revision without the book advancing.
      const advanced = await tx
        .update(userBooks)
        .set({ workflowStatus: 'trial_generating', currentTrialRevisionId: revision.id, updatedAt: new Date() })
        .where(and(
          eq(userBooks.id, userBookId),
          eq(userBooks.currentStrategyDraftVersionId, draftId),
          inArray(userBooks.workflowStatus, ['strategy_review', 'trial_generation_failed']),
        ))
        .returning({ id: userBooks.id });
      if (advanced.length !== 1) throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
      if (operationClaim) {
        const completed = await tx
          .update(readingSetupOperations)
          .set({
            status: 'completed',
            leaseId: null,
            leaseClaimedAt: null,
            leaseExpiresAt: null,
            resultStrategyDraftVersionId: null,
            resultTrialRevisionId: revision.id,
            errorSummary: null,
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(and(
            eq(readingSetupOperations.id, operationClaim.operationId),
            eq(readingSetupOperations.status, 'running'),
            eq(readingSetupOperations.leaseId, operationClaim.leaseId),
            eq(readingSetupOperations.attemptCount, operationClaim.attemptCount),
            sql`${readingSetupOperations.leaseExpiresAt} > now()`,
            eq(readingSetupOperations.baseStrategyDraftVersionId, draftId),
            isNull(readingSetupOperations.baseTrialRevisionId),
          ))
          .returning({ id: readingSetupOperations.id });
        if (completed.length !== 1) throw new ReadingSetupLeaseLostError();
      }
      return { revision, generationIds };
    });
    await enqueueTrialRevisionGenerations(userBookId, created.revision.id, created.generationIds);
    return created.revision;
  };

  // §3.5: after approval, run one agent turn that reads the candidate node bodies and
  // returns exactly three block-range fragments (threshold / typical / hardest). The host
  // pre-extracts the candidate nodes' blocks into the turn context so the agent picks real
  // ranges in a single turn; the returned fragments are validated by createTrialRevision.
  const selectTrialFragments = async (
    userBookId: string,
    draft: StrategyReviewResponse['draft'],
    optionsForRun: {
      assertLeaseActive(): void;
      onStream?: (delta: TrialSelectionTurnStreamDelta) => void;
    },
  ): Promise<TrialCandidate[]> => {
    const setup = await getSetupContext(userBookId);
    const { manifest, html } = await getManifestAndHtml(setup.owned.sharedBook.id);
    const candidateKeys = new Set(
      draft.strategy.trialCandidates.map((candidate) => `${candidate.sectionId}:${candidate.segment}`),
    );
    if (candidateKeys.size !== 3) throw new UserBookError('处理方式中的试读候选不完整', 409);
    const projectFragment = (
      fragment: TrialFragmentStreamValue,
      seenTags: Set<TrialFragmentStreamValue['tag']>,
      seenNodes: Set<string>,
    ): ProvisionalTrialSample => {
      const ordinal = fragment.tag === 'threshold' ? 1 : fragment.tag === 'typical' ? 2 : 3;
      const key = `${fragment.section_id}:${fragment.segment}`;
      const node = manifest.nodes.find(
        (item) => item.section_id === fragment.section_id && item.segment === fragment.segment,
      );
      if (
        !candidateKeys.has(key)
        || !node?.tailoring_eligible
        || seenTags.has(fragment.tag)
        || seenNodes.has(key)
      ) {
        throw new UserBookError('试读片段选择不符合当前候选位置', 409);
      }
      const range = {
        start: { blockIndex: fragment.range.start.block_index, offset: fragment.range.start.offset },
        end: { blockIndex: fragment.range.end.block_index, offset: fragment.range.end.offset },
      };
      const source = extractNodeSourceFromHtml(html, fragment.section_id, fragment.segment);
      assertRangeWithinBlocks(source.blocks, range);
      const sliced = sliceNodeSource(source, fragment.range);
      seenTags.add(fragment.tag);
      seenNodes.add(key);
      return {
        ordinal,
        tag: fragment.tag,
        sectionId: fragment.section_id,
        segment: fragment.segment,
        range,
        chapterPath: chapterPath(node, manifest.outline),
        originalHtml: sliced.structuredHtml,
        selectionReason: fragment.reason,
      } as ProvisionalTrialSample;
    };
    const trialNodeContents = draft.strategy.trialCandidates.map((candidate) => {
      const node = manifest.nodes.find(
        (item) => item.section_id === candidate.sectionId && item.segment === candidate.segment,
      );
      const source = extractNodeSourceFromHtml(html, candidate.sectionId, candidate.segment);
      return {
        section_id: candidate.sectionId,
        segment: candidate.segment,
        title: node?.title ?? '',
        tailoring_eligible: node?.tailoring_eligible ?? false,
        blocks: source.blocks.map((block) => ({ block_index: block.block_index, text: block.text })),
      };
    });
    let streamedEpoch = 0;
    let streamedTags = new Set<TrialFragmentStreamValue['tag']>();
    let streamedNodes = new Set<string>();
    const outcome = await options.setupEngine.runTurn({
      sessionId: setup.owned.userBook.currentInterviewSessionId!,
      phase: 'select_trial',
      askedCount: 0,
      context: { ...setup.context, currentStrategy: draft, trialNodeContents },
      ...(requestContext.requestId ? { requestId: requestContext.requestId } : {}),
      ...(optionsForRun.onStream ? {
        onStream: (delta: ReadingSetupStreamDelta) => {
          optionsForRun.assertLeaseActive();
          if (delta.type === 'speculative_reset') {
            streamedEpoch = delta.speculativeEpoch;
            streamedTags = new Set<TrialFragmentStreamValue['tag']>();
            streamedNodes = new Set<string>();
            optionsForRun.onStream?.(delta);
            return;
          }
          if (delta.speculativeEpoch < streamedEpoch) return;
          if (delta.speculativeEpoch > streamedEpoch) {
            streamedEpoch = delta.speculativeEpoch;
            streamedTags = new Set<TrialFragmentStreamValue['tag']>();
            streamedNodes = new Set<string>();
          }
          if (delta.type === 'selection_started') {
            optionsForRun.onStream?.(delta);
          } else if (delta.type === 'fragment_added') {
            try {
              optionsForRun.onStream?.({
                type: 'fragment_selected',
                speculativeEpoch: delta.speculativeEpoch,
                sample: projectFragment(delta.fragment, streamedTags, streamedNodes),
              });
            } catch (error) {
              if (!(error instanceof UserBookError)) throw error;
            }
          }
        },
      } : {}),
    });
    if (outcome.type !== 'fragments') throw new UserBookError('试读片段选择失败', 503);
    const finalTags = new Set<TrialFragmentStreamValue['tag']>();
    const finalNodes = new Set<string>();
    const selected = outcome.fragments
      .map((fragment) => projectFragment(fragment, finalTags, finalNodes))
      .sort((left, right) => left.ordinal - right.ordinal);
    if (selected.length !== 3 || finalTags.size !== 3 || finalNodes.size !== 3) {
      throw new UserBookError('试读片段选择结果不完整', 409);
    }
    optionsForRun.assertLeaseActive();
    return selected.map((sample) => ({
      sectionId: sample.sectionId,
      segment: sample.segment,
      reason: sample.selectionReason,
      tag: sample.tag,
      range: sample.range,
    }));
  };

  const trialStateByRevisionId = async (
    userBookId: string,
    revisionId: string,
  ): Promise<TrialReviewResponse> => {
    const owned = await getOwnedBook(userBookId);
    const [revision, segmentRows, source] = await Promise.all([
      db
        .select()
        .from(trialRevisions)
        .where(and(
          eq(trialRevisions.id, revisionId),
          eq(trialRevisions.userBookId, userBookId),
        ))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({ segment: trialSegments, generation: nodeGenerations })
        .from(trialSegments)
        .leftJoin(nodeGenerations, eq(nodeGenerations.trialSegmentId, trialSegments.id))
        .where(eq(trialSegments.trialRevisionId, revisionId))
        .orderBy(asc(trialSegments.ordinal)),
      getManifestAndHtml(owned.sharedBook.id),
    ]);
    if (!revision) throw new UserBookError('试读版本不存在', 404);
    const segments = segmentRows.map(({ segment, generation }) => {
      const extracted = extractNodeSourceFromHtml(source.html, segment.sectionId, segment.segment);
      const range = {
        start: { block_index: segment.startBlockIndex, offset: segment.startOffset },
        end: { block_index: segment.endBlockIndex, offset: segment.endOffset },
      };
      const sliced = sliceNodeSource(extracted, range);
      const node = source.manifest.nodes.find((item) => item.section_id === segment.sectionId && item.segment === segment.segment)!;
      const common = {
        id: segment.id,
        ordinal: segment.ordinal,
        sectionId: segment.sectionId,
        segment: segment.segment,
        range: {
          start: { blockIndex: segment.startBlockIndex, offset: segment.startOffset },
          end: { blockIndex: segment.endBlockIndex, offset: segment.endOffset },
        },
        chapterPath: chapterPath(node, source.manifest.outline),
        originalHtml: sliced.structuredHtml,
        selectionReason: segment.selectionReason,
        viewedAt: segment.viewedAt?.toISOString() ?? null,
      };
      if (segment.status === 'ready' && generation?.status === 'ready' && generation.result) {
        return { ...common, status: 'ready' as const, result: generation.result };
      }
      if (segment.status === 'generating') {
        return { ...common, status: 'generating' as const, result: null };
      }
      if (segment.status === 'failed' || segment.status === 'ready') {
        return { ...common, status: 'failed' as const, result: null };
      }
      return { ...common, status: 'pending' as const, result: null };
    });
    const isCurrent = owned.userBook.workflowStatus === 'trial_review'
      && owned.userBook.currentTrialRevisionId === revision.id;
    return {
      userBookId,
      workflowStatus: owned.userBook.workflowStatus,
      trialRevisionId: revision.id,
      revision: revision.revision,
      status: revision.status,
      strategyDraftVersionId: revision.strategyDraftVersionId,
      segments,
      adjustmentCount: owned.userBook.adjustmentCount,
      adjustmentLimit: ADJUSTMENT_LIMIT,
      canAdjust: isCurrent && owned.userBook.adjustmentCount < ADJUSTMENT_LIMIT,
      // Adoption only requires the three fragments to be generated and published — the reader
      // is not forced to open all three first (the prototype has no such gate).
      canAdopt: isCurrent
        && revision.status === 'published'
        && segments.length === 3
        && segments.every((segment) => segment.status === 'ready'),
    };
  };

  const trialState = async (userBookId: string): Promise<TrialReviewResponse> => {
    const owned = await getOwnedBook(userBookId);
    const revisionId = owned.userBook.currentTrialRevisionId;
    if (!revisionId) throw new UserBookError('当前试读不存在', 409);
    return trialStateByRevisionId(userBookId, revisionId);
  };

  const runPreparedRevisionOperation = async (
    prepared: PreparedReadingSetupOperation,
    onStream?: (delta: RevisionTurnStreamDelta) => void,
  ): Promise<string> => {
    const operation = prepared.operation;
    if (operation.kind !== 'strategy_revision') {
      throw new UserBookError('阅读准备操作类型不匹配', 409);
    }
    if (operation.status === 'completed') {
      if (!operation.resultStrategyDraftVersionId) {
        throw new UserBookError('阅读准备操作结果损坏', 409);
      }
      return operation.resultStrategyDraftVersionId;
    }
    if (!prepared.claim) {
      throw new UserBookError(operation.errorSummary ?? '阅读准备操作失败', 503);
    }
    if (operation.payload.source === 'strategy_approve') {
      throw new UserBookError('阅读准备操作载荷不匹配', 409);
    }

    const claim = prepared.claim;
    const lease = startOperationLeaseRenewal(claim);
    try {
      const current = await strategyStateByDraftId(
        operation.userBookId,
        operation.baseStrategyDraftVersionId,
      );
      lease.assertActive();
      return await reviseFromFeedback(operation.userBookId, {
        draft: current.draft,
        feedback: operation.payload.feedback,
        idempotencyKey: operation.idempotencyKey,
        ...(operation.payload.source === 'trial_feedback'
          ? { trialRevisionId: operation.payload.trialRevisionId }
          : {}),
        operationClaim: claim,
        assertLeaseActive: () => lease.assertActive(),
        ...(onStream ? { onStream } : {}),
      });
    } catch (error) {
      if (!(error instanceof ReadingSetupLeaseLostError)) {
        const failed = await failReadingSetupOperation(claim, error).catch(() => false);
        if (!failed) throw new ReadingSetupLeaseLostError();
      }
      throw error;
    } finally {
      lease.stop();
    }
  };

  const executeRevisionOperation = async (
    initialOperation: ReadingSetupOperationRow,
  ): Promise<StrategyReviewResponse> => {
    const prepared = await prepareReadingSetupOperationExecution(initialOperation);
    try {
      const resultDraftId = await runPreparedRevisionOperation(prepared);
      return await strategyStateByDraftId(initialOperation.userBookId, resultDraftId);
    } catch (error) {
      if (error instanceof ReadingSetupLeaseLostError) {
        throw new UserBookError('阅读准备操作已由新请求接管，请查询恢复状态', 409);
      }
      throw error;
    }
  };

  const createStrategyRevisionStreamEmitter = (
    operation: ReadingSetupOperationRow,
    operationAttempt: number,
  ) => {
    let sequence = 0;
    return (payload: StrategyRevisionStreamPayload): StrategyRevisionStreamEvent => ({
      userBookId: operation.userBookId,
      operationId: operation.id,
      operationAttempt,
      sequence: sequence += 1,
      ...payload,
    } as StrategyRevisionStreamEvent);
  };

  const streamRevisionOperation = async function* (
    initialOperation: ReadingSetupOperationRow,
  ): AsyncGenerator<StrategyRevisionStreamEvent> {
    if (initialOperation.status === 'running') {
      const observed = await observeOperationById(initialOperation.userBookId, initialOperation.id);
      if (observed && !observed.leaseExpired) {
        throw new UserBookError('阅读准备操作仍在处理中，请查询恢复状态', 409);
      }
    }
    const prepared = await prepareReadingSetupOperationExecution(initialOperation, false);
    const operation = prepared.operation;
    if (operation.kind !== 'strategy_revision' || operation.payload.source === 'strategy_approve') {
      throw new UserBookError('阅读准备操作类型不匹配', 409);
    }
    const operationAttempt = prepared.claim?.attemptCount ?? operation.attemptCount;
    if (operationAttempt < 1) throw new UserBookError('阅读准备操作尚未开始', 409);
    const emit = createStrategyRevisionStreamEmitter(operation, operationAttempt);
    const bridge = createStreamBridge<StrategyRevisionStreamEvent>();
    let resultDraftId: string | undefined;
    let operationError: unknown;
    const running = runPreparedRevisionOperation(prepared, (delta) => {
      switch (delta.type) {
        case 'speculative_reset':
          bridge.push(emit({
            type: 'speculative_reset',
            speculativeEpoch: delta.speculativeEpoch,
            phase: 'strategy_review',
          }));
          break;
        case 'draft_started':
          bridge.push(emit({
            type: 'revision_started',
            speculativeEpoch: delta.speculativeEpoch,
            source: operation.source,
            baseDraftId: operation.baseStrategyDraftVersionId,
            baseTrialRevisionId: operation.baseTrialRevisionId,
          } as StrategyRevisionStreamPayload));
          break;
        case 'strategy_delta':
          bridge.push(emit({
            type: 'strategy_delta',
            speculativeEpoch: delta.speculativeEpoch,
            chars: delta.chars,
          }));
          break;
        case 'reading_node_added':
          bridge.push(emit({
            type: 'reading_node_added',
            speculativeEpoch: delta.speculativeEpoch,
            node: delta.node,
          }));
          break;
      }
    })
      .then((value) => {
        resultDraftId = value;
      })
      .catch((error: unknown) => {
        operationError = error;
      })
      .finally(() => bridge.end());

    for await (const event of bridge.drain()) yield event;
    await running;
    if (operationError) {
      const code: ReadingSetupStreamErrorCode = operationError instanceof ReadingSetupLeaseLostError
        ? 'lease_lost'
        : operationError instanceof UserBookError && operationError.statusCode < 500
          ? 'validation_failed'
          : 'agent_failed';
      yield emit({
        type: 'error',
        code,
        message: operationError instanceof UserBookError
          ? operationError.message
          : code === 'lease_lost'
            ? '阅读准备操作已由新的恢复请求接管。'
            : '处理方式修订失败，请稍后重试。',
      });
      return;
    }
    if (!resultDraftId) {
      yield emit({ type: 'error', code: 'internal_error', message: '处理方式修订结果缺失。' });
      return;
    }
    try {
      const strategy = await strategyStateByDraftId(operation.userBookId, resultDraftId);
      yield emit({ type: 'revision_final', strategy });
    } catch {
      yield emit({
        type: 'error',
        code: 'internal_error',
        message: '修订已经完成，正在重新读取最终结果。',
      });
    }
  };

  const resolveStrategyFeedbackOperation = async (
    userBookId: string,
    input: SubmitStrategyFeedbackRequest,
  ) => {
    const strategyDraftVersionId = input.strategyDraftVersionId.toLowerCase();
    const feedback = input.feedback.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!UUID_RE.test(strategyDraftVersionId) || !feedback || !idempotencyKey) {
      throw new UserBookError('处理方式反馈请求无效', 400);
    }
    return resolveReadingSetupOperation(userBookId, {
      kind: 'strategy_revision',
      source: 'strategy_feedback',
      baseStrategyDraftVersionId: strategyDraftVersionId,
      baseTrialRevisionId: null,
      idempotencyKey,
      payload: {
        source: 'strategy_feedback',
        strategyDraftVersionId,
        feedback,
      },
    });
  };

  const resolveTrialFeedbackOperation = async (
    userBookId: string,
    input: SubmitTrialFeedbackRequest,
  ) => {
    const trialRevisionId = input.trialRevisionId.toLowerCase();
    const feedback = input.feedback.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!UUID_RE.test(trialRevisionId) || !feedback || !idempotencyKey) {
      throw new UserBookError('试读反馈请求无效', 400);
    }
    await getOwnedBook(userBookId);
    const [revision] = await db
      .select({ strategyDraftVersionId: trialRevisions.strategyDraftVersionId })
      .from(trialRevisions)
      .where(and(
        eq(trialRevisions.id, trialRevisionId),
        eq(trialRevisions.userBookId, userBookId),
      ))
      .limit(1);
    if (!revision) throw new UserBookError('试读版本不存在', 404);
    return resolveReadingSetupOperation(userBookId, {
      kind: 'strategy_revision',
      source: 'trial_feedback',
      baseStrategyDraftVersionId: revision.strategyDraftVersionId,
      baseTrialRevisionId: trialRevisionId,
      idempotencyKey,
      payload: {
        source: 'trial_feedback',
        strategyDraftVersionId: revision.strategyDraftVersionId,
        trialRevisionId,
        feedback,
      },
    });
  };

  const resolveApproveStrategyOperation = async (
    userBookId: string,
    input: ApproveStrategyRequest,
  ) => {
    const strategyDraftVersionId = input.strategyDraftVersionId.toLowerCase();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!UUID_RE.test(strategyDraftVersionId) || !idempotencyKey) {
      throw new UserBookError('处理方式确认请求无效', 400);
    }
    return resolveReadingSetupOperation(userBookId, {
      kind: 'trial_selection',
      source: 'strategy_approve',
      baseStrategyDraftVersionId: strategyDraftVersionId,
      baseTrialRevisionId: null,
      idempotencyKey,
      payload: {
        source: 'strategy_approve',
        strategyDraftVersionId,
      },
    });
  };

  const runPreparedTrialSelectionOperation = async (
    prepared: PreparedReadingSetupOperation,
    onStream?: (delta: TrialSelectionTurnStreamDelta) => void,
  ): Promise<string> => {
    const operation = prepared.operation;
    if (operation.kind !== 'trial_selection' || operation.payload.source !== 'strategy_approve') {
      throw new UserBookError('阅读准备操作类型不匹配', 409);
    }
    if (operation.status === 'completed') {
      if (!operation.resultTrialRevisionId) {
        throw new UserBookError('阅读准备操作结果损坏', 409);
      }
      return operation.resultTrialRevisionId;
    }
    if (!prepared.claim) {
      throw new UserBookError(operation.errorSummary ?? '阅读准备操作失败', 503);
    }

    const claim = prepared.claim;
    const lease = startOperationLeaseRenewal(claim);
    try {
      const current = await strategyStateByDraftId(
        operation.userBookId,
        operation.baseStrategyDraftVersionId,
      );
      lease.assertActive();
      const fragments = await selectTrialFragments(operation.userBookId, current.draft, {
        assertLeaseActive: () => lease.assertActive(),
        ...(onStream ? { onStream } : {}),
      });
      lease.assertActive();
      const revision = await createTrialRevision(
        operation.userBookId,
        current.draft.id,
        true,
        fragments,
        claim,
      );
      return revision.id;
    } catch (error) {
      if (!(error instanceof ReadingSetupLeaseLostError)) {
        const failed = await failReadingSetupOperation(claim, error).catch(() => false);
        if (!failed) throw new ReadingSetupLeaseLostError();
      }
      throw error;
    } finally {
      lease.stop();
    }
  };

  const executeTrialSelectionOperation = async (
    initialOperation: ReadingSetupOperationRow,
  ): Promise<ApproveStrategyResponse> => {
    const prepared = await prepareReadingSetupOperationExecution(initialOperation);
    try {
      const resultTrialRevisionId = await runPreparedTrialSelectionOperation(prepared);
      const snapshot = await trialStateByRevisionId(initialOperation.userBookId, resultTrialRevisionId);
      return {
        userBookId: initialOperation.userBookId,
        workflowStatus: snapshot.workflowStatus,
        strategyDraftVersionId: snapshot.strategyDraftVersionId,
        trialRevisionId: snapshot.trialRevisionId,
      };
    } catch (error) {
      if (error instanceof ReadingSetupLeaseLostError) {
        throw new UserBookError('阅读准备操作已由新请求接管，请查询恢复状态', 409);
      }
      throw error;
    }
  };

  const createTrialSelectionStreamEmitter = (
    operation: ReadingSetupOperationRow,
    operationAttempt: number,
  ) => {
    let sequence = 0;
    return (payload: TrialSelectionStreamPayload): TrialSelectionStreamEvent => ({
      userBookId: operation.userBookId,
      operationId: operation.id,
      operationAttempt,
      sequence: sequence += 1,
      ...payload,
    } as TrialSelectionStreamEvent);
  };

  const streamTrialSelectionOperation = async function* (
    initialOperation: ReadingSetupOperationRow,
  ): AsyncGenerator<TrialSelectionStreamEvent> {
    if (initialOperation.status === 'running') {
      const observed = await observeOperationById(initialOperation.userBookId, initialOperation.id);
      if (observed && !observed.leaseExpired) {
        throw new UserBookError('阅读准备操作仍在处理中，请查询恢复状态', 409);
      }
    }
    const prepared = await prepareReadingSetupOperationExecution(initialOperation, false);
    const operation = prepared.operation;
    if (operation.kind !== 'trial_selection' || operation.payload.source !== 'strategy_approve') {
      throw new UserBookError('阅读准备操作类型不匹配', 409);
    }
    const operationAttempt = prepared.claim?.attemptCount ?? operation.attemptCount;
    if (operationAttempt < 1) throw new UserBookError('阅读准备操作尚未开始', 409);
    const emit = createTrialSelectionStreamEmitter(operation, operationAttempt);
    const bridge = createStreamBridge<TrialSelectionStreamEvent>();
    let resultTrialRevisionId: string | undefined;
    let operationError: unknown;
    const running = runPreparedTrialSelectionOperation(prepared, (delta) => {
      switch (delta.type) {
        case 'speculative_reset':
          bridge.push(emit({
            type: 'speculative_reset',
            speculativeEpoch: delta.speculativeEpoch,
            phase: 'select_trial',
          }));
          break;
        case 'selection_started':
          bridge.push(emit({
            type: 'selection_started',
            speculativeEpoch: delta.speculativeEpoch,
            draftId: operation.baseStrategyDraftVersionId,
            slots: [
              { ordinal: 1, tag: 'threshold' },
              { ordinal: 2, tag: 'typical' },
              { ordinal: 3, tag: 'hardest' },
            ],
          }));
          break;
        case 'fragment_selected':
          bridge.push(emit({
            type: 'fragment_selected',
            speculativeEpoch: delta.speculativeEpoch,
            draftId: operation.baseStrategyDraftVersionId,
            sample: delta.sample,
          }));
          break;
      }
    })
      .then((value) => {
        resultTrialRevisionId = value;
      })
      .catch((error: unknown) => {
        operationError = error;
      })
      .finally(() => bridge.end());

    for await (const event of bridge.drain()) yield event;
    await running;
    if (operationError) {
      const code: ReadingSetupStreamErrorCode = operationError instanceof ReadingSetupLeaseLostError
        ? 'lease_lost'
        : operationError instanceof UserBookError && operationError.statusCode < 500
          ? 'validation_failed'
          : 'agent_failed';
      yield emit({
        type: 'error',
        code,
        message: operationError instanceof UserBookError
          ? operationError.message
          : code === 'lease_lost'
            ? '阅读准备操作已由新的恢复请求接管。'
            : '试读片段选择失败，请稍后重试。',
      });
      return;
    }
    if (!resultTrialRevisionId) {
      yield emit({ type: 'error', code: 'internal_error', message: '试读片段选择结果缺失。' });
      return;
    }
    try {
      const trial = await trialStateByRevisionId(operation.userBookId, resultTrialRevisionId);
      yield emit({
        type: 'trial_created',
        draftId: operation.baseStrategyDraftVersionId,
        trial,
      });
    } catch {
      yield emit({
        type: 'error',
        code: 'internal_error',
        message: '试读版本已经创建，正在重新读取最终结果。',
      });
    }
  };

  const resumeReadingSetupOperation = async (
    userBookId: string,
    operationId: string,
  ) => {
    await getOwnedBook(userBookId);
    const operation = await readOperationById(userBookId, operationId);
    if (!operation) throw new UserBookError('阅读准备操作不存在', 404);
    if (operation.kind === 'strategy_revision') {
      await executeRevisionOperation(operation);
    } else {
      await executeTrialSelectionOperation(operation);
    }
    const latest = await observeOperationById(userBookId, operationId);
    if (!latest) throw new UserBookError('阅读准备操作不存在', 404);
    return projectReadingSetupOperation(latest.operation, latest.leaseExpired);
  };

  const enqueuePendingFormalGenerations = async (userBookId: string) => {
    const [book, resume, readRows, candidates] = await Promise.all([
      db.select({ strategyVersionId: userBooks.currentStrategyVersionId })
        .from(userBooks).where(eq(userBooks.id, userBookId)).limit(1).then((rows) => rows[0]),
      db.select({ sectionId: readerStates.sectionId, segment: readerStates.segment })
        .from(readerStates).where(eq(readerStates.userBookId, userBookId)).limit(1).then((rows) => rows[0]),
      db.select().from(readerReadNodes).where(eq(readerReadNodes.userBookId, userBookId)),
      db.select({
        id: nodeGenerations.id,
        strategyVersionId: nodeGenerations.strategyVersionId,
        sectionId: nodeGenerations.sectionId,
        segment: nodeGenerations.segment,
      }).from(nodeGenerations).where(and(
        eq(nodeGenerations.userBookId, userBookId),
        eq(nodeGenerations.generationScope, 'formal'),
        inArray(nodeGenerations.status, ['queued', 'retrying']),
      )),
    ]);
    if (!book?.strategyVersionId) return;
    const currentKey = resume ? `${resume.sectionId}\0${resume.segment}` : null;
    const pins = new Map(
      readRows.map((row) => [`${row.sectionId}\0${row.segment}`, row.strategyVersionId]),
    );
    const pending = candidates.filter((generation) => {
      const key = `${generation.sectionId}\0${generation.segment}`;
      const expected = key === currentKey
        ? book.strategyVersionId
        : pins.get(key) ?? book.strategyVersionId;
      return generation.strategyVersionId === expected;
    });
    try {
      await Promise.all(pending.map((generation) => options.generations.enqueue({
        generationId: generation.id,
        userBookId,
        scope: 'formal',
        // Recovery re-enqueue has no reading focus: keep it in the background band so the
        // position-driven window (priority 1..N) always wins.
        priority: FORMAL_BACKGROUND_PRIORITY,
      })));
    } catch (error) {
      throw new UserBookError(
        error instanceof Error ? `正式内容任务入队失败：${error.message}` : '正式内容任务入队失败',
        503,
      );
    }
  };

  // §6.2 / PRD §11.3 lazy-loading window: keep the reader's current node plus the next
  // FORMAL_WINDOW_SIZE-1 tailoring-eligible nodes queued/generating/ready, and give them the
  // most urgent BullMQ priorities (1..N) so a jump 提权s the target and its lookahead. Missing
  // formal node_generations are created on demand; the partial unique index makes the insert
  // idempotent under concurrent focus reports.
  const ensureFormalWindow = async (
    userBookId: string,
    strategyVersionId: string,
    sharedBookId: string,
    focusOrder: number,
  ) => {
    const { manifest } = await getManifestAndHtml(sharedBookId);
    const eligible = manifest.nodes
      .filter((node) => node.tailoring_eligible)
      .sort((left, right) => left.order - right.order);
    if (eligible.length === 0) return;
    const anchor = Number.isFinite(focusOrder) ? focusOrder : eligible[0]!.order;
    const ahead = eligible.filter((node) => node.order >= anchor).slice(0, FORMAL_WINDOW_SIZE);
    // Focus past the last eligible node → keep the tail warm rather than generate nothing.
    const window = ahead.length > 0 ? ahead : eligible.slice(-FORMAL_WINDOW_SIZE);
    await db
      .insert(nodeGenerations)
      .values(window.map((node) => ({
        id: randomUUID(),
        userBookId,
        generationScope: 'formal' as const,
        strategyVersionId,
        sectionId: node.section_id,
        segment: node.segment,
        status: 'queued' as const,
        modelConfigId: options.modelConfigId,
        promptVersion: 'tailoring-content-1.0',
        cacheKey: `pending:${randomUUID()}`,
      })))
      .onConflictDoNothing();
    const rows = await db
      .select({
        id: nodeGenerations.id,
        sectionId: nodeGenerations.sectionId,
        segment: nodeGenerations.segment,
        status: nodeGenerations.status,
      })
      .from(nodeGenerations)
      .where(and(
        eq(nodeGenerations.userBookId, userBookId),
        eq(nodeGenerations.generationScope, 'formal'),
        eq(nodeGenerations.strategyVersionId, strategyVersionId),
        inArray(nodeGenerations.sectionId, [...new Set(window.map((node) => node.section_id))]),
      ));
    const byKey = new Map(rows.map((row) => [`${row.sectionId}:${row.segment}`, row]));
    const enqueues: Array<Promise<void>> = [];
    window.forEach((node, index) => {
      const row = byKey.get(`${node.section_id}:${node.segment}`);
      if (!row || (row.status !== 'queued' && row.status !== 'retrying')) return;
      enqueues.push(options.generations.enqueue({
        generationId: row.id,
        userBookId,
        scope: 'formal',
        priority: index + 1,
      }));
    });
    try {
      await Promise.all(enqueues);
    } catch (error) {
      throw new UserBookError(
        error instanceof Error ? `正式内容任务入队失败：${error.message}` : '正式内容任务入队失败',
        503,
      );
    }
  };

  // §11.5 — persist the reader's anchor. The anchor's node is the focus node (`order`). Two guards
  // make a bad or stale event a no-op instead of a corruption (fix §2.2/§2.3/§4.3):
  //   1. Validate `order` against the manifest: its section_id/segment must match the position, else
  //      the anchor was spliced from two nodes — skip the write (but never block the read).
  //   2. Conditional upsert on client_observed_at: only overwrite when the incoming event is at
  //      least as new as the stored one, so an earlier observation that arrives late cannot clobber
  //      a newer position. `updated_at` still records the write time but is no longer the authority.
  const persistReaderPosition = async (
    userBookId: string,
    sharedBookId: string,
    order: number,
    position: ReaderPosition,
  ): Promise<void> => {
    const meta = await getManifestMeta(options.books, sharedBookId);
    if (!positionMatchesManifest(meta, order, position.sectionId, position.segment)) return;
    const values = {
      sectionId: position.sectionId,
      segment: position.segment,
      blockIndex: position.blockIndex,
      offset: position.offset,
      nodeOrder: order,
      manifestVersion: meta.version,
      clientObservedAt: new Date(position.clientObservedAt),
      updatedAt: new Date(),
    };
    await db
      .insert(readerStates)
      .values({ userBookId, ...values })
      .onConflictDoUpdate({
        target: readerStates.userBookId,
        set: values,
        setWhere: sql`excluded.client_observed_at >= ${readerStates.clientObservedAt}`,
      });
  };

  // §11.6 — the user's global reader settings, falling back to the shared default when no row
  // exists yet. Read with each bootstrap so a change on another device shows up on refetch.
  const loadReadingSettings = async (): Promise<ReadingSettings> => {
    const [row] = await db
      .select({ settings: userReadingSettings.settings })
      .from(userReadingSettings)
      .where(eq(userReadingSettings.userId, userId))
      .limit(1);
    return row?.settings ?? DEFAULT_READING_SETTINGS;
  };

  // §11.7 — map a highlight row to the flat-columns → nested-range contract shape.
  const mapHighlight = (row: typeof highlights.$inferSelect): Highlight => ({
    id: row.id,
    sectionId: row.sectionId,
    segment: row.segment,
    range: {
      start: { blockIndex: row.startBlockIndex, offset: row.startOffset },
      end: { blockIndex: row.endBlockIndex, offset: row.endOffset },
    },
    note: row.note,
    quoteSnapshot: row.quoteSnapshot,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  // §11.7 — all highlights for a book, oldest first, so the reader renders and lists them in a stable
  // creation order. Delivered with bootstrap and re-read for the standalone list endpoint.
  const loadHighlights = async (userBookId: string): Promise<Highlight[]> => {
    const rows = await db
      .select()
      .from(highlights)
      .where(eq(highlights.userBookId, userBookId))
      .orderBy(asc(highlights.createdAt));
    return rows.map(mapHighlight);
  };

  const buildReaderBootstrap = async (
    userBookId: string,
    sharedBookId: string,
    strategyVersionId: string,
    strategyDraftVersionId: string,
  ): Promise<ReaderBootstrap> => {
    const [strategy, draft, generations, resume, settings, readRows, highlightList] = await Promise.all([
      db.select().from(strategyVersions).where(eq(strategyVersions.id, strategyVersionId)).limit(1).then((rows) => rows[0]),
      db.select().from(strategyDraftVersions).where(eq(strategyDraftVersions.id, strategyDraftVersionId)).limit(1).then((rows) => rows[0]),
      db.select().from(nodeGenerations).where(and(eq(nodeGenerations.userBookId, userBookId), eq(nodeGenerations.generationScope, 'formal'))).orderBy(asc(nodeGenerations.createdAt)),
      db.select().from(readerStates).where(eq(readerStates.userBookId, userBookId)).limit(1).then((rows) => rows[0]),
      loadReadingSettings(),
      db.select({
        sectionId: readerReadNodes.sectionId,
        segment: readerReadNodes.segment,
        strategyVersionId: readerReadNodes.strategyVersionId,
      })
        .from(readerReadNodes)
        .where(eq(readerReadNodes.userBookId, userBookId)),
      loadHighlights(userBookId),
    ]);
    if (!strategy || !draft) throw new UserBookError('正式处理方式不存在', 409);
    const currentKey = resume ? `${resume.sectionId}\0${resume.segment}` : null;
    const readPins = new Map(
      readRows.map((row) => [`${row.sectionId}\0${row.segment}`, row.strategyVersionId]),
    );
    const expectedGenerations = generations.filter((generation) => {
      const key = `${generation.sectionId}\0${generation.segment}`;
      const expectedStrategyVersionId = key === currentKey
        ? strategyVersionId
        : readPins.get(key) ?? strategyVersionId;
      return generation.strategyVersionId === expectedStrategyVersionId;
    });
    return {
      userBookId,
      sharedBookId,
      workflowStatus: 'active_reading',
      strategyVersionId: strategy.id,
      strategyVersion: strategy.version,
      briefing: draft.readingBriefing,
      strategySummary: strategy.userFacingSummary,
      enhancements: expectedGenerations.map((generation) => ({
        generationId: generation.id,
        strategyVersionId: generation.strategyVersionId!,
        sectionId: generation.sectionId,
        segment: generation.segment,
        status: generation.status,
        result: generation.result,
      })),
      resumePosition: resume
        ? {
          sectionId: resume.sectionId,
          segment: resume.segment,
          blockIndex: resume.blockIndex,
          offset: resume.offset,
          clientObservedAt: resume.clientObservedAt.toISOString(),
          nodeOrder: resume.nodeOrder,
          manifestVersion: resume.manifestVersion,
        }
        : null,
      settings,
      readNodes: readRows.map((row) => ({ sectionId: row.sectionId, segment: row.segment })),
      highlights: highlightList,
    };
  };

  // ── 问 AI (§8) ───────────────────────────────────────────────────────────────
  // Each HTTP request runs one conversational turn; the thread history is rebuilt from
  // qa_messages every turn (stateless-resume, §2.4). The agent may patch the long-term reader
  // profile and stage a pending strategy-change proposal. Only an explicit confirm command creates
  // a formal strategy version and regenerates the current reading window.

  // Per-request toolbox bound to this book's manifest/HTML and the thread's anchor. Read tools
  // reuse extractNodeSourceFromHtml / extractNodeTexts; there is no spoiler guard by design
  // (§8.2 — Q&A may read ahead). propose_strategy_change only validates + acknowledges here; the
  // pending row is written atomically with the answer in saveQaAnswer (so a failed turn leaves
  // no orphan proposal), then surfaced with stable persisted IDs.
  const buildAskAiToolbox = (
    owned: { userBook: typeof userBooks.$inferSelect },
    questionContext: QaQuestionContext,
    manifest: ReadingManifest,
    html: string,
  ): AskAiToolbox => {
    const nodeByKey = new Map(
      manifest.nodes.map((node) => [`${node.section_id}\0${node.segment}`, node] as const),
    );
    const nodeTitle = (sectionId: string, segment: number) =>
      nodeByKey.get(`${sectionId}\0${segment}`)?.title ?? '';
    const outlineNode = (node: ManifestNode) => ({
      section_id: node.section_id,
      segment: node.segment,
      order: node.order,
      title: node.title ?? '',
      tailoring_eligible: node.tailoring_eligible,
    });
    // Built once per request, lazily — only if search_book is actually called (one full parse).
    let searchIndex: Array<{ sectionId: string; segment: number; text: string }> | null = null;
    const ensureSearchIndex = () => {
      if (!searchIndex) {
        const keys = new Set(nodeByKey.keys());
        searchIndex = extractNodeTexts(html).filter((node) =>
          keys.has(`${node.sectionId}\0${node.segment}`),
        );
      }
      return searchIndex;
    };
    const readNodeText = (sectionId: string, segment: number, maxCharacters: number): string => {
      const source = extractNodeSourceFromHtml(html, sectionId, segment);
      const text = source.blocks.map((block) => block.text).join('\n\n').trim();
      return text.length > maxCharacters ? `${text.slice(0, maxCharacters)}…（已截断）` : text;
    };
    return {
      async getQuestionContext() {
        const { sectionId, segment, anchor } = questionContext;
        const title = nodeTitle(sectionId, segment);
        let contextText: string;
        try {
          contextText = questionContext.range
            ? qaRangeText(html, sectionId, segment, questionContext.range)
            : readNodeText(sectionId, segment, 6000);
        } catch {
          contextText = readNodeText(sectionId, segment, 6000);
        }
        const lines = [
          `锚点类型：${anchor === 'highlight' ? '用户划线' : '当前屏幕'}`,
          `定位精度：${questionContext.precision}`,
          `所在节点：section_id=${sectionId} segment=${segment}${title ? ` 标题=${title}` : ''}`,
        ];
        lines.push(`${anchor === 'highlight' ? '划线原文' : '当前屏幕原文'}：\n${contextText}`);
        return { text: lines.join('\n\n') };
      },
      async getBookOutline(input) {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? 100;
        return {
          text: JSON.stringify(
            {
              ...(offset === 0 ? { outline: manifest.outline } : {}),
              nodes: manifest.nodes.slice(offset, offset + limit).map(outlineNode),
              offset,
              next_offset: offset + limit < manifest.nodes.length ? offset + limit : null,
              total: manifest.nodes.length,
            },
            null,
            2,
          ),
        };
      },
      async readBookNode(input) {
        try {
          const text = readNodeText(input.sectionId, input.segment, input.maxCharacters ?? 6000);
          const title = nodeTitle(input.sectionId, input.segment);
          return { text: `${title ? `【${title}】\n` : ''}${text}` };
        } catch {
          return { text: `未找到节点 section_id=${input.sectionId} segment=${input.segment}` };
        }
      },
      async searchBook(input) {
        const query = input.query.trim();
        if (!query) return { text: '（查询为空）' };
        const limit = Math.min(input.limit ?? 20, 50);
        const needle = query.toLowerCase();
        const hits: Array<{ section_id: string; segment: number; title: string; snippet: string }> = [];
        for (const node of ensureSearchIndex()) {
          const at = node.text.toLowerCase().indexOf(needle);
          if (at === -1) continue;
          const start = Math.max(0, at - 60);
          const end = Math.min(node.text.length, at + needle.length + 60);
          hits.push({
            section_id: node.sectionId,
            segment: node.segment,
            title: nodeTitle(node.sectionId, node.segment),
            snippet: `${start > 0 ? '…' : ''}${node.text.slice(start, end)}${end < node.text.length ? '…' : ''}`,
          });
          if (hits.length >= limit) break;
        }
        return { text: JSON.stringify({ query, total: hits.length, hits }, null, 2) };
      },
      async getOriginalNotes(input) {
        const sectionId = input.sectionId ?? questionContext.sectionId;
        const segment = input.segment ?? questionContext.segment;
        try {
          const { originalNotes } = extractNodeSourceFromHtml(html, sectionId, segment);
          if (originalNotes.length === 0) {
            return { text: `节点 ${sectionId}#${segment} 没有原书脚注/尾注。` };
          }
          return { text: originalNotes.map((note) => `[${note.id}] ${note.html}`).join('\n\n') };
        } catch {
          return { text: `未找到节点 section_id=${sectionId} segment=${segment}` };
        }
      },
      async getReaderContext() {
        const [readerProfile, bookReaderProfile, strategy] = await Promise.all([
          getReaderProfile(userId).catch(() => null),
          owned.userBook.currentBookReaderProfileVersionId
            ? db
                .select()
                .from(bookReaderProfileVersions)
                .where(eq(bookReaderProfileVersions.id, owned.userBook.currentBookReaderProfileVersionId))
                .limit(1)
                .then((rows) => rows[0])
            : Promise.resolve(undefined),
          owned.userBook.currentStrategyVersionId
            ? db
                .select()
                .from(strategyVersions)
                .where(eq(strategyVersions.id, owned.userBook.currentStrategyVersionId))
                .limit(1)
                .then((rows) => rows[0])
            : Promise.resolve(undefined),
        ]);
        return {
          text: JSON.stringify(
            {
              long_term_reader_profile: readerProfile?.profile ?? null,
              this_book_reader_profile: bookReaderProfile?.profile ?? null,
              current_strategy: strategy
                ? { user_facing_summary: strategy.userFacingSummary, strategy: strategy.strategy }
                : null,
            },
            null,
            2,
          ),
        };
      },
      async updateReaderProfile(patch) {
        if (
          !patch.knowledge?.length
          && !patch.remove_knowledge?.length
          && !patch.explanation_preferences?.length
          && !patch.remove_explanation_preferences?.length
        ) {
          return { text: '画像补丁为空，未记录更新。' };
        }
        return { text: '已暂存长期画像更新，将在本次回答成功后统一保存。' };
      },
      async proposeStrategyChange(proposal) {
        // Validate the structured strategy up-front (fails fast on a malformed proposal); the row
        // is persisted after the turn in saveQaAnswer. Read-only: this never lands a strategy.
        mapProposedStrategy(proposal.strategy);
        return {
          text: '已记录该处理方式调整建议，回答结束后会作为「待确认」建议展示给用户；用户确认后才会生效。',
        };
      },
    };
  };

  // Resolve-or-create the thread and append the user's question (idempotent on idempotencyKey
  // within the thread). A new thread requires `context` (the anchor); a follow-up reuses the
  // thread's stored anchor. The question lands before any agent turn so a stream that dies later
  // is recoverable — a retry re-runs the turn (§8, mirrors commitInterviewAnswer).
  const commitQaQuestion = async (userBookId: string, input: AskQuestionRequest) => {
    const owned = await getOwnedBook(userBookId);
    if (owned.userBook.workflowStatus !== 'active_reading') {
      throw new UserBookError('尚未开始阅读，暂不能提问', 409);
    }
    // Trim before persisting so a whitespace-only body (which passes the schema's minLength:1)
    // can't hit the content non-empty CHECK as a raw 500 (mirrors the interview answer path).
    const question = input.question.trim();
    if (!question) throw new UserBookError('问题不能为空', 400);
    let session: typeof qaSessions.$inferSelect;
    if (input.sessionId) {
      const [row] = await db
        .select()
        .from(qaSessions)
        .where(and(eq(qaSessions.id, input.sessionId), eq(qaSessions.userBookId, userBookId)))
        .limit(1);
      if (!row) throw new UserBookError('问答会话不存在', 404);
      if (row.status !== 'active') throw new UserBookError('该问答会话已结束', 409);
      session = row;
    } else {
      if (!input.context) throw new UserBookError('发起提问需要提供上下文', 400);
      const source = await getManifestAndHtml(owned.sharedBook.id);
      const normalized = normalizeQaQuestionContext(input.context, source.manifest, source.html, true);
      const [created] = await db
        .insert(qaSessions)
        .values({ userBookId, questionContext: normalized.context })
        .returning();
      if (!created) throw new UserBookError('问答会话创建失败', 503);
      session = created;
    }
    // CAS-first (like saveQaAnswer): claim the next sequence by advancing conversation_version,
    // then insert — so a concurrent duplicate/second question loses the CAS and retries rather
    // than racing two INSERTs into a raw unique-violation. The idempotency pre-check inside the
    // loop makes a same-key retry return the prior row instead of committing twice.
    let committed: { questionMessageId: string; questionSequence: number } | undefined;
    for (let attempt = 0; attempt < 6 && !committed; attempt += 1) {
      committed = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(qaMessages)
          .where(
            and(
              eq(qaMessages.qaSessionId, session.id),
              eq(qaMessages.kind, 'question'),
              eq(qaMessages.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (existing) return { questionMessageId: existing.id, questionSequence: existing.sequence };
        const [fresh] = await tx
          .select({ conversationVersion: qaSessions.conversationVersion, status: qaSessions.status })
          .from(qaSessions)
          .where(eq(qaSessions.id, session.id))
          .limit(1);
        if (!fresh || fresh.status !== 'active') throw new UserBookError('该问答会话已结束', 409);
        const sequence = fresh.conversationVersion + 1;
        const advanced = await tx
          .update(qaSessions)
          .set({ conversationVersion: sequence, updatedAt: new Date() })
          .where(
            and(
              eq(qaSessions.id, session.id),
              eq(qaSessions.status, 'active'),
              eq(qaSessions.conversationVersion, fresh.conversationVersion),
            ),
          )
          .returning({ id: qaSessions.id });
        if (advanced.length !== 1) return undefined; // lost the CAS — retry
        const [message] = await tx
          .insert(qaMessages)
          .values({
            qaSessionId: session.id,
            sequence,
            role: 'user',
            kind: 'question',
            content: question,
            idempotencyKey: input.idempotencyKey,
          })
          .returning();
        if (!message) throw new UserBookError('问题写入失败', 503);
        return { questionMessageId: message.id, questionSequence: sequence };
      });
    }
    if (!committed) throw new UserBookError('提问写入冲突，请重试', 409);
    return {
      owned,
      sessionId: session.id,
      questionContext: session.questionContext as QaQuestionContext,
      question,
      ...committed,
    };
  };

  // The already-committed answer for a question, if its turn finished. Located by the explicit
  // `payload.q = questionSequence` link (NOT by sequence arithmetic) so an intervening second
  // question in the same thread can't cause a different question's answer to be misidentified.
  // Drives idempotent replay and post-failure recovery in streamQaAnswer.
  const findQaAnswer = async (sessionId: string, questionSequence: number) => {
    const [answer] = await db
      .select()
      .from(qaMessages)
      .where(
        and(
          eq(qaMessages.qaSessionId, sessionId),
          eq(qaMessages.kind, 'answer'),
          sql`${qaMessages.payload}->>'q' = ${String(questionSequence)}`,
        ),
      )
      .limit(1);
    return answer;
  };

  // Rebuild the agent's view of the thread (§2.4): prior turns as flat text + the active
  // proposal's current state. The *current* question is passed separately (agent.prompt), so we
  // include only messages before it.
  const buildQaContext = async (
    sessionId: string,
    questionContext: QaQuestionContext,
    questionSequence: number,
  ): Promise<Record<string, unknown>> => {
    const [priorMessages, proposal] = await Promise.all([
      db
        .select()
        .from(qaMessages)
        .where(and(eq(qaMessages.qaSessionId, sessionId), sql`${qaMessages.sequence} < ${questionSequence}`))
        .orderBy(asc(qaMessages.sequence)),
      db
        .select()
        .from(strategyChangeProposals)
        .where(eq(strategyChangeProposals.qaSessionId, sessionId))
        .orderBy(desc(strategyChangeProposals.createdAt))
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    return {
      questionContext,
      messages: priorMessages.map((message) => ({ role: message.role, content: message.content })),
      ...(proposal
        ? {
            proposal: {
              status: proposal.status,
              public_summary: proposal.publicSummary,
              ...(proposal.feedback ? { feedback: proposal.feedback } : {}),
            },
          }
        : {}),
    };
  };

  // Persist the answer + (optional) pending proposal atomically once the turn succeeds. The
  // answer takes the next sequence (current conversation_version + 1, claimed by CAS) and is
  // linked to its question via `payload.q` — decoupled from the question's own sequence so an
  // intervening question can't wedge this save. Idempotent: if the question is already answered
  // (e.g. a concurrent duplicate turn), return that answer instead of writing a second. §8.2: at
  // most one pending proposal per book — a new one supersedes the old still-pending one;
  // confirmation is a separate idempotent command and never runs as part of answer persistence.
  const saveQaAnswer = async (
    userBookId: string,
    sessionId: string,
    questionSequence: number,
    question: string,
    outcome: AskAiOutcome,
    observedStrategyVersionId: string | null,
  ): Promise<{
    messageId: string;
    profileUpdated: boolean;
    proposal?: {
      proposalId: string;
      revisionId: string;
      revision: number;
      triggeringMessageId: string;
      publicSummary: string;
      status: 'pending';
    };
  }> => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await db.transaction(async (tx): Promise<{
        messageId: string;
        profileUpdated: boolean;
        proposal?: {
          proposalId: string;
          revisionId: string;
          revision: number;
          triggeringMessageId: string;
          publicSummary: string;
          status: 'pending';
        };
      } | undefined> => {
        const [existing] = await tx
          .select({ id: qaMessages.id })
          .from(qaMessages)
          .where(
            and(
              eq(qaMessages.qaSessionId, sessionId),
              eq(qaMessages.kind, 'answer'),
              sql`${qaMessages.payload}->>'q' = ${String(questionSequence)}`,
            ),
          )
          .limit(1);
        if (existing) return { messageId: existing.id, profileUpdated: false };
        const [fresh] = await tx
          .select({
            conversationVersion: qaSessions.conversationVersion,
            status: qaSessions.status,
            questionContext: qaSessions.questionContext,
          })
          .from(qaSessions)
          .where(eq(qaSessions.id, sessionId))
          .limit(1);
        if (!fresh || fresh.status !== 'active') throw new UserBookError('问答会话状态已变化', 409);
        const sequence = fresh.conversationVersion + 1;
        const advanced = await tx
          .update(qaSessions)
          .set({ conversationVersion: sequence, updatedAt: new Date() })
          .where(
            and(
              eq(qaSessions.id, sessionId),
              eq(qaSessions.status, 'active'),
              eq(qaSessions.conversationVersion, fresh.conversationVersion),
            ),
          )
          .returning({ id: qaSessions.id });
        if (advanced.length !== 1) return undefined; // lost the CAS — retry
        const [message] = await tx
          .insert(qaMessages)
          .values({
            qaSessionId: sessionId,
            sequence,
            role: 'assistant',
            kind: 'answer',
            content: outcome.answer,
            payload: {
              q: questionSequence,
              ...(outcome.proposedStrategyChange
                ? { proposed_strategy_change: outcome.proposedStrategyChange }
                : {}),
            },
          })
          .returning();
        if (!message) throw new UserBookError('回答写入失败', 503);

        let profileUpdated = false;
        if (outcome.readerProfilePatch) {
          const [profileRow] = await tx
            .select()
            .from(readerProfiles)
            .where(eq(readerProfiles.userId, userId))
            .for('update')
            .limit(1);
          if (profileRow?.currentVersionId) {
            const [currentProfile] = await tx
              .select()
              .from(readerProfileVersions)
              .where(eq(readerProfileVersions.id, profileRow.currentVersionId))
              .limit(1);
            if (currentProfile) {
              const nextProfile = applyReaderProfilePatch(currentProfile.profile, outcome.readerProfilePatch);
              profileUpdated =
                JSON.stringify(nextProfile.knowledge) !== JSON.stringify(currentProfile.profile.knowledge)
                || JSON.stringify(nextProfile.explanationPreferences)
                  !== JSON.stringify(currentProfile.profile.explanationPreferences);
              if (profileUpdated) {
                const [nextVersion] = await tx
                  .insert(readerProfileVersions)
                  .values({
                    readerProfileId: profileRow.id,
                    version: currentProfile.version + 1,
                    profile: nextProfile,
                    changeSource: 'question_answer',
                    sourceQaSessionId: sessionId,
                    sourceQaMessageId: message.id,
                    changeReason: `问答中识别到可复用的长期信息：${question.slice(0, 500)}`,
                  })
                  .returning();
                if (!nextVersion) throw new UserBookError('画像更新保存失败', 503);
                await tx
                  .update(readerProfiles)
                  .set({ currentVersionId: nextVersion.id, updatedAt: new Date() })
                  .where(eq(readerProfiles.id, profileRow.id));
              }
            }
          }
        }

        let savedProposal:
          | {
              proposalId: string;
              revisionId: string;
              revision: number;
              triggeringMessageId: string;
              publicSummary: string;
              status: 'pending';
            }
          | undefined;
        if (outcome.proposedStrategyChange) {
          const [book] = await tx
            .select()
            .from(userBooks)
            .where(eq(userBooks.id, userBookId))
            .for('update')
            .limit(1);
          if (
            !book
            || book.workflowStatus !== 'active_reading'
            || !book.currentStrategyVersionId
            || !book.currentBookReaderProfileVersionId
          ) {
            throw new UserBookError('当前正式处理方式不可调整', 409);
          }
          if (book.currentStrategyVersionId !== observedStrategyVersionId) {
            throw new UserBookError('正式处理方式已变化，请重试以基于新方式重新生成建议', 409);
          }
          const [baseStrategy] = await tx
            .select()
            .from(strategyVersions)
            .where(eq(strategyVersions.id, book.currentStrategyVersionId))
            .limit(1);
          if (!baseStrategy) throw new UserBookError('当前正式处理方式不存在', 409);
          const [sourceDraft] = await tx
            .select()
            .from(strategyDraftVersions)
            .where(eq(strategyDraftVersions.id, baseStrategy.sourceDraftVersionId))
            .limit(1);
          if (!sourceDraft) throw new UserBookError('当前处理方式来源不存在', 409);
          const proposedStrategy = mapProposedStrategy(outcome.proposedStrategyChange.strategy);
          const [versionRow] = await tx
            .select({
              nextVersion: sql<number>`coalesce(max(${strategyDraftVersions.version}), 0)::int + 1`,
            })
            .from(strategyDraftVersions)
            .where(eq(strategyDraftVersions.userBookId, userBookId));
          const nextVersion = versionRow?.nextVersion ?? 1;
          const [candidateDraft] = await tx
            .insert(strategyDraftVersions)
            .values({
              userBookId,
              bookReaderProfileVersionId: book.currentBookReaderProfileVersionId,
              sourceQaMessageId: message.id,
              version: nextVersion,
              status: 'draft',
              readingBriefing: sourceDraft.readingBriefing,
              userFacingSummary: outcome.proposedStrategyChange.public_summary,
              strategy: {
                ...proposedStrategy,
                trialCandidates: baseStrategy.strategy.trialCandidates,
              },
            })
            .returning();
          if (!candidateDraft) throw new UserBookError('候选处理方式保存失败', 503);

          const [pending] = await tx
            .select()
            .from(strategyChangeProposals)
            .where(
              and(
                eq(strategyChangeProposals.userBookId, userBookId),
                eq(strategyChangeProposals.status, 'pending'),
              ),
            )
            .limit(1);
          const reviseExisting =
            pending?.qaSessionId === sessionId
            && pending.baseStrategyVersionId === book.currentStrategyVersionId;
          let proposalId: string;
          let revision: number;
          if (reviseExisting && pending) {
            proposalId = pending.id;
            revision = pending.revision + 1;
            await tx
              .update(strategyDraftVersions)
              .set({ status: 'superseded', supersededAt: new Date() })
              .where(
                and(
                  eq(strategyDraftVersions.id, pending.currentStrategyDraftVersionId),
                  eq(strategyDraftVersions.status, 'draft'),
                ),
              );
          } else {
            if (pending) {
              await tx
                .update(strategyDraftVersions)
                .set({ status: 'superseded', supersededAt: new Date() })
                .where(
                  and(
                    eq(strategyDraftVersions.id, pending.currentStrategyDraftVersionId),
                    eq(strategyDraftVersions.status, 'draft'),
                  ),
                );
              await tx
                .update(strategyChangeProposals)
                .set({ status: 'superseded', supersededAt: new Date(), updatedAt: new Date() })
                .where(eq(strategyChangeProposals.id, pending.id));
            }
            const storedContext = fresh.questionContext as Record<string, unknown>;
            const [readerState] = await tx
              .select()
              .from(readerStates)
              .where(eq(readerStates.userBookId, userBookId))
              .limit(1);
            const originSectionId =
              typeof storedContext.sectionId === 'string'
                ? storedContext.sectionId
                : readerState?.sectionId;
            const originSegment =
              typeof storedContext.segment === 'number'
                ? storedContext.segment
                : readerState?.segment;
            if (!originSectionId || !originSegment) {
              throw new UserBookError('处理方式建议缺少阅读位置', 409);
            }
            const [proposal] = await tx
              .insert(strategyChangeProposals)
              .values({
                userBookId,
                qaSessionId: sessionId,
                triggeringMessageId: message.id,
                revision: 1,
                currentStrategyDraftVersionId: candidateDraft.id,
                baseStrategyVersionId: book.currentStrategyVersionId,
                originSectionId,
                originSegment,
                originNodeOrder:
                  typeof storedContext.nodeOrder === 'number'
                    ? storedContext.nodeOrder
                    : readerState?.nodeOrder ?? 1,
                publicSummary: outcome.proposedStrategyChange.public_summary,
                proposedStrategy,
              })
              .returning();
            if (!proposal) throw new UserBookError('处理方式建议保存失败', 503);
            proposalId = proposal.id;
            revision = 1;
          }
          const [revisionRow] = await tx
            .insert(strategyChangeProposalRevisions)
            .values({
              proposalId,
              revision,
              triggeringMessageId: message.id,
              strategyDraftVersionId: candidateDraft.id,
              publicSummary: outcome.proposedStrategyChange.public_summary,
              changedFields: outcome.proposedStrategyChange.changed_fields.length > 0
                ? outcome.proposedStrategyChange.changed_fields
                : changedStrategyFields(baseStrategy.strategy, proposedStrategy),
              reason: outcome.proposedStrategyChange.reason,
              evidence: outcome.proposedStrategyChange.evidence.join('\n'),
            })
            .returning();
          if (!revisionRow) throw new UserBookError('处理方式建议修订保存失败', 503);
          await tx
            .update(strategyChangeProposals)
            .set({
              triggeringMessageId: message.id,
              revision,
              currentRevisionId: revisionRow.id,
              currentStrategyDraftVersionId: candidateDraft.id,
              baseStrategyVersionId: book.currentStrategyVersionId,
              publicSummary: outcome.proposedStrategyChange.public_summary,
              proposedStrategy,
              feedback: null,
              updatedAt: new Date(),
            })
            .where(eq(strategyChangeProposals.id, proposalId));
          savedProposal = {
            proposalId,
            revisionId: revisionRow.id,
            revision,
            triggeringMessageId: message.id,
            publicSummary: revisionRow.publicSummary,
            status: 'pending',
          };
        }
        return {
          messageId: message.id,
          profileUpdated,
          ...(savedProposal ? { proposal: savedProposal } : {}),
        };
      });
      if (result) return result;
    }
    throw new UserBookError('回答写入冲突，请重试', 409);
  };

  const actionResponse = (value: Record<string, unknown>): ProposalActionResponse => {
    if (
      typeof value.proposalId !== 'string'
      || typeof value.revisionId !== 'string'
      || !['pending', 'confirmed', 'rejected', 'superseded'].includes(String(value.status))
    ) {
      throw new UserBookError('建议操作结果损坏', 409);
    }
    return {
      proposalId: value.proposalId,
      revisionId: value.revisionId,
      status: value.status as ProposalActionResponse['status'],
      resultingStrategyVersionId:
        typeof value.resultingStrategyVersionId === 'string'
          ? value.resultingStrategyVersionId
          : null,
    };
  };

  const replayProposalAction = (
    row: typeof strategyChangeProposalActions.$inferSelect,
    action: 'feedback' | 'confirm' | 'reject',
    revisionId: string,
    payload: Record<string, unknown>,
  ): ProposalActionResponse => {
    if (
      row.action !== action
      || row.revisionId !== revisionId
      || !proposalActionPayloadMatches(row.payload, payload)
    ) {
      throw new UserBookError('幂等键已用于不同的建议操作', 409);
    }
    return actionResponse(row.result);
  };

  return {
    async list(): Promise<UserBookShelfResponse> {
      const rows = await db
        .select({ userBook: userBooks, sharedBook: sharedBooks })
        .from(userBooks)
        .innerJoin(sharedBooks, eq(sharedBooks.id, userBooks.sharedBookId))
        .where(and(eq(userBooks.userId, userId), isNull(userBooks.deletedAt)))
        .orderBy(desc(userBooks.updatedAt));
      return { books: rows.map(shelfItem) };
    },

    async detail(userBookId: string): Promise<UserBookDetailResponse> {
      const owned = await getOwnedBook(userBookId);
      return {
        book: shelfItem(owned),
        currentInterviewSessionId: owned.userBook.currentInterviewSessionId,
        currentBookReaderProfileVersionId: owned.userBook.currentBookReaderProfileVersionId,
        currentStrategyDraftVersionId: owned.userBook.currentStrategyDraftVersionId,
        currentStrategyVersionId: owned.userBook.currentStrategyVersionId,
        currentTrialRevisionId: owned.userBook.currentTrialRevisionId,
        adjustmentCount: owned.userBook.adjustmentCount,
        deletedAt: owned.userBook.deletedAt?.toISOString() ?? null,
        purgeAfter: owned.userBook.purgeAfter?.toISOString() ?? null,
        createdAt: owned.userBook.createdAt.toISOString(),
        updatedAt: owned.userBook.updatedAt.toISOString(),
      };
    },

    currentReadingSetupOperation,

    async readingSetupOperation(userBookId: string, operationId: string) {
      await getOwnedBook(userBookId);
      const observed = await observeOperationById(userBookId, operationId);
      if (!observed) throw new UserBookError('阅读准备操作不存在', 404);
      return projectReadingSetupOperation(observed.operation, observed.leaseExpired);
    },

    resumeReadingSetupOperation,

    interviewState,

    async startInterview(userBookId: string): Promise<InterviewStateResponse> {
      const sessionId = await ensureInterviewSession(userBookId);
      await resumePendingInterviewTurn(userBookId, sessionId);
      return readInterviewState(userBookId);
    },

    async resumeInterview(userBookId: string): Promise<InterviewStateResponse> {
      const owned = await getOwnedBook(userBookId);
      const sessionId = owned.userBook.currentInterviewSessionId;
      if (owned.userBook.workflowStatus !== 'interviewing' || !sessionId) {
        throw new UserBookError('当前访谈不需要恢复', 409);
      }
      await resumePendingInterviewTurn(userBookId, sessionId);
      return readInterviewState(userBookId);
    },

    async *streamResumeInterview(userBookId: string): AsyncGenerator<InterviewStreamEvent> {
      const owned = await getOwnedBook(userBookId);
      const sessionId = owned.userBook.currentInterviewSessionId;
      if (owned.userBook.workflowStatus !== 'interviewing' || !sessionId) {
        throw new UserBookError('当前访谈不需要恢复', 409);
      }
      const claim = await claimInterviewTurn(sessionId);
      if (!claim) throw new UserBookError('访谈仍在处理中', 409);
      yield* streamClaimedInterviewTurn(userBookId, claim);
    },

    // Streaming answer endpoint (§4). Commits the answer, then runs the interviewing turn,
    // yielding token-level deltas as the model streams the next question — or `concluding`
    // then `done` when it finishes the interview. Validation errors are thrown before the
    // first yield so the route can still surface them as HTTP status codes; failures after the
    // stream opens become an in-band `error` event.
    async *streamInterviewAnswer(
      userBookId: string,
      input: SubmitInterviewAnswerRequest,
    ): AsyncGenerator<InterviewStreamEvent> {
      const committed = await commitInterviewAnswer(userBookId, input);
      const claim = committed.claim ?? await claimInterviewTurn(committed.sessionId);
      if (claim) {
        yield* streamClaimedInterviewTurn(userBookId, claim);
        return;
      }
      yield* terminalInterviewEvents(
        userBookId,
        createInterviewStreamEmitter(userBookId, randomUUID()),
      );
    },

    strategyState,
    strategyStateByDraftId,

    async submitStrategyFeedback(userBookId: string, input: SubmitStrategyFeedbackRequest) {
      const operation = await resolveStrategyFeedbackOperation(userBookId, input);
      return executeRevisionOperation(operation);
    },

    async *streamStrategyFeedback(userBookId: string, input: SubmitStrategyFeedbackRequest) {
      const operation = await resolveStrategyFeedbackOperation(userBookId, input);
      yield* streamRevisionOperation(operation);
    },

    async approveStrategy(userBookId: string, input: ApproveStrategyRequest): Promise<ApproveStrategyResponse> {
      const operation = await resolveApproveStrategyOperation(userBookId, input);
      return executeTrialSelectionOperation(operation);
    },

    async *streamApproveStrategy(userBookId: string, input: ApproveStrategyRequest) {
      const operation = await resolveApproveStrategyOperation(userBookId, input);
      yield* streamTrialSelectionOperation(operation);
    },

    trialState,
    trialStateByRevisionId,

    async retryTrial(userBookId: string) {
      await getOwnedBook(userBookId);
      const created = await db.transaction(async (tx) => {
        const now = new Date();
        const [book] = await tx
          .select()
          .from(userBooks)
          .where(and(
            eq(userBooks.id, userBookId),
            eq(userBooks.userId, userId),
            isNull(userBooks.deletedAt),
          ))
          .limit(1)
          .for('update');
        if (
          !book
          || book.workflowStatus !== 'trial_generation_failed'
          || !book.currentTrialRevisionId
          || !book.currentStrategyDraftVersionId
        ) {
          throw new UserBookError('当前试读不需要重试', 409);
        }

        const [revision] = await tx
          .select()
          .from(trialRevisions)
          .where(and(
            eq(trialRevisions.id, book.currentTrialRevisionId),
            eq(trialRevisions.userBookId, userBookId),
          ))
          .limit(1)
          .for('update');
        if (
          !revision
          || revision.status !== 'failed'
          || revision.strategyDraftVersionId !== book.currentStrategyDraftVersionId
        ) {
          throw new UserBookError('试读状态已经更新', 409);
        }

        const [draft] = await tx
          .select({ id: strategyDraftVersions.id, status: strategyDraftVersions.status })
          .from(strategyDraftVersions)
          .where(and(
            eq(strategyDraftVersions.id, revision.strategyDraftVersionId),
            eq(strategyDraftVersions.userBookId, userBookId),
          ))
          .limit(1)
          .for('update');
        if (!draft || draft.status !== 'approved_for_trial') {
          throw new UserBookError('试读使用的处理方式已经失效', 409);
        }

        const segments = await tx
          .select()
          .from(trialSegments)
          .where(eq(trialSegments.trialRevisionId, revision.id))
          .orderBy(asc(trialSegments.ordinal))
          .for('update');
        if (segments.length !== 3) {
          throw new UserBookError('失败试读版本的片段数据不完整', 409);
        }
        const generations = await tx
          .select()
          .from(nodeGenerations)
          .where(and(
            eq(nodeGenerations.userBookId, userBookId),
            eq(nodeGenerations.generationScope, 'trial'),
            inArray(nodeGenerations.trialSegmentId, segments.map((segment) => segment.id)),
          ))
          .for('update');
        const retryPlan = buildTrialRetryPlan(revision.strategyDraftVersionId, segments, generations);

        const supersededGenerations = await tx
          .update(nodeGenerations)
          .set({
            status: 'superseded',
            result: null,
            completedAt: now,
            updatedAt: now,
          })
          .where(and(
            inArray(nodeGenerations.id, retryPlan.map((item) => item.generation.id)),
            eq(nodeGenerations.userBookId, userBookId),
            eq(nodeGenerations.generationScope, 'trial'),
            inArray(nodeGenerations.status, ['queued', 'generating', 'retrying', 'ready', 'failed']),
          ))
          .returning({ id: nodeGenerations.id });
        if (supersededGenerations.length !== 3) {
          throw new UserBookError('试读状态已经更新', 409);
        }
        const [supersededRevision] = await tx
          .update(trialRevisions)
          .set({ status: 'superseded', supersededAt: now, updatedAt: now })
          .where(and(
            eq(trialRevisions.id, revision.id),
            eq(trialRevisions.status, 'failed'),
          ))
          .returning({ id: trialRevisions.id });
        if (!supersededRevision) throw new UserBookError('试读状态已经更新', 409);

        const [lastRevision] = await tx
          .select({ revision: trialRevisions.revision })
          .from(trialRevisions)
          .where(eq(trialRevisions.userBookId, userBookId))
          .orderBy(desc(trialRevisions.revision))
          .limit(1);
        const [newRevision] = await tx
          .insert(trialRevisions)
          .values({
            userBookId,
            strategyDraftVersionId: revision.strategyDraftVersionId,
            revision: (lastRevision?.revision ?? revision.revision) + 1,
            status: 'generating',
          })
          .returning();
        if (!newRevision) throw new Error('failed to create retry trial revision');

        const newSegments = await tx
          .insert(trialSegments)
          .values(retryPlan.map(({ segment }) => ({
            trialRevisionId: newRevision.id,
            ordinal: segment.ordinal,
            sectionId: segment.sectionId,
            segment: segment.segment,
            startBlockIndex: segment.startBlockIndex,
            startOffset: segment.startOffset,
            endBlockIndex: segment.endBlockIndex,
            endOffset: segment.endOffset,
            selectionReason: segment.selectionReason,
            status: 'pending' as const,
          })))
          .returning({ id: trialSegments.id, ordinal: trialSegments.ordinal });
        if (newSegments.length !== 3) throw new Error('failed to copy retry trial segments');
        const newSegmentIdByOrdinal = new Map(
          newSegments.map((segment) => [segment.ordinal, segment.id]),
        );
        const generationIds = retryPlan.map(({ segment, generation }) => {
          const trialSegmentId = newSegmentIdByOrdinal.get(segment.ordinal);
          if (!trialSegmentId) throw new Error('failed to map retry trial segment');
          return {
            id: randomUUID(),
            userBookId,
            generationScope: 'trial' as const,
            trialSegmentId,
            strategyDraftVersionId: revision.strategyDraftVersionId,
            sectionId: segment.sectionId,
            segment: segment.segment,
            status: 'queued' as const,
            maxAttempts: generation.maxAttempts,
            modelConfigId: generation.modelConfigId,
            promptVersion: generation.promptVersion,
          };
        });
        await tx.insert(nodeGenerations).values(generationIds.map((generation) => ({
          ...generation,
          cacheKey: `pending:${generation.id}`,
        })));

        const [advanced] = await tx
          .update(userBooks)
          .set({
            workflowStatus: 'trial_generating',
            currentTrialRevisionId: newRevision.id,
            updatedAt: now,
          })
          .where(and(
            eq(userBooks.id, userBookId),
            eq(userBooks.workflowStatus, 'trial_generation_failed'),
            eq(userBooks.currentTrialRevisionId, revision.id),
            eq(userBooks.currentStrategyDraftVersionId, revision.strategyDraftVersionId),
          ))
          .returning({ id: userBooks.id });
        if (!advanced) throw new UserBookError('试读状态已经更新', 409);
        return { revisionId: newRevision.id, generationIds: generationIds.map((row) => row.id) };
      });
      await enqueueTrialRevisionGenerations(userBookId, created.revisionId, created.generationIds);
      return trialStateByRevisionId(userBookId, created.revisionId);
    },

    async markTrialViewed(userBookId: string, input: MarkTrialSegmentViewedRequest) {
      await db.transaction(async (tx) => {
        const [book] = await tx.select().from(userBooks).where(eq(userBooks.id, userBookId)).limit(1);
        const [revision] = await tx.select().from(trialRevisions).where(and(
          eq(trialRevisions.id, input.trialRevisionId),
          eq(trialRevisions.userBookId, userBookId),
        )).limit(1);
        if (
          !book
          || book.workflowStatus !== 'trial_review'
          || book.currentTrialRevisionId !== input.trialRevisionId
          || !revision
          || revision.status !== 'published'
        ) {
          throw new UserBookError('试读版本尚未发布或已经更新', 409);
        }
        const changed = await tx
          .update(trialSegments)
          .set({ viewedAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(trialSegments.id, input.trialSegmentId),
            eq(trialSegments.trialRevisionId, input.trialRevisionId),
            eq(trialSegments.status, 'ready'),
          ))
          .returning({ id: trialSegments.id });
        if (changed.length !== 1) throw new UserBookError('试读片段不存在或尚未准备好', 409);
      });
      return trialState(userBookId);
    },

    async submitTrialFeedback(userBookId: string, input: SubmitTrialFeedbackRequest) {
      const operation = await resolveTrialFeedbackOperation(userBookId, input);
      return executeRevisionOperation(operation);
    },

    async *streamTrialFeedback(userBookId: string, input: SubmitTrialFeedbackRequest) {
      const operation = await resolveTrialFeedbackOperation(userBookId, input);
      yield* streamRevisionOperation(operation);
    },

    async adoptTrial(userBookId: string, input: AdoptTrialRequest): Promise<AdoptTrialResponse> {
      const owned = await getOwnedBook(userBookId);
      if (owned.userBook.workflowStatus === 'active_reading' && owned.userBook.currentStrategyVersionId) {
        await enqueuePendingFormalGenerations(userBookId);
        return { userBookId, workflowStatus: 'active_reading', strategyVersionId: owned.userBook.currentStrategyVersionId };
      }
      const current = await trialState(userBookId);
      if (!current.canAdopt || current.trialRevisionId !== input.trialRevisionId || current.strategyDraftVersionId !== input.strategyDraftVersionId) {
        throw new UserBookError('三个试读片段尚未全部生成，或试读版本已经更新', 409);
      }
      const { manifest } = await getManifestAndHtml(owned.sharedBook.id);
      const formalNodes = manifest.nodes.filter((item) => item.tailoring_eligible).slice(0, FORMAL_WINDOW_SIZE);
      if (formalNodes.length === 0) throw new UserBookError('书籍没有可生成的正式阅读节点', 409);
      const result = await db.transaction(async (tx) => {
        const [bookGate] = await tx
          .select()
          .from(userBooks)
          .where(eq(userBooks.id, userBookId))
          .limit(1);
        if (bookGate?.workflowStatus === 'active_reading' && bookGate.currentStrategyVersionId) {
          const [existing] = await tx
            .select()
            .from(strategyVersions)
            .where(eq(strategyVersions.id, bookGate.currentStrategyVersionId))
            .limit(1);
          if (existing) return { strategy: existing, created: false };
        }
        if (
          !bookGate
          || bookGate.workflowStatus !== 'trial_review'
          || bookGate.currentTrialRevisionId !== input.trialRevisionId
          || bookGate.currentStrategyDraftVersionId !== input.strategyDraftVersionId
        ) {
          throw new UserBookError('试读状态已经更新', 409);
        }
        const [revision] = await tx
          .select()
          .from(trialRevisions)
          .where(and(
            eq(trialRevisions.id, input.trialRevisionId),
            eq(trialRevisions.userBookId, userBookId),
          ))
          .limit(1);
        if (
          !revision
          || revision.status !== 'published'
          || revision.strategyDraftVersionId !== input.strategyDraftVersionId
        ) {
          throw new UserBookError('试读版本已经失效', 409);
        }
        const segments = await tx
          .select()
          .from(trialSegments)
          .where(eq(trialSegments.trialRevisionId, revision.id));
        if (segments.length !== 3 || segments.some((segment) => segment.status !== 'ready')) {
          throw new UserBookError('三个试读片段尚未全部生成', 409);
        }
        const [draft] = await tx
          .update(strategyDraftVersions)
          .set({ status: 'confirmed', confirmedAt: new Date() })
          .where(and(
            eq(strategyDraftVersions.id, input.strategyDraftVersionId),
            eq(strategyDraftVersions.userBookId, userBookId),
            eq(strategyDraftVersions.status, 'approved_for_trial'),
          ))
          .returning();
        if (!draft) {
          const [existing] = await tx
            .select()
            .from(strategyVersions)
            .where(eq(strategyVersions.sourceDraftVersionId, input.strategyDraftVersionId))
            .limit(1);
          if (existing) return { strategy: existing, created: false };
          throw new UserBookError('处理方式已经更新', 409);
        }
        const [strategy] = await tx.insert(strategyVersions).values({
          userBookId,
          sourceDraftVersionId: draft.id,
          version: 1,
          userFacingSummary: draft.userFacingSummary,
          strategy: draft.strategy,
        }).returning();
        if (!strategy) throw new Error('failed to create formal strategy');
        const generationIds: string[] = [];
        for (const node of formalNodes) {
          const id = randomUUID();
          await tx.insert(nodeGenerations).values({
            id,
            userBookId,
            generationScope: 'formal',
            strategyVersionId: strategy.id,
            sectionId: node.section_id,
            segment: node.segment,
            status: 'queued',
            modelConfigId: options.modelConfigId,
            promptVersion: 'tailoring-content-1.0',
            cacheKey: `pending:${id}`,
          });
          generationIds.push(id);
        }
        const adopted = await tx
          .update(trialRevisions)
          .set({ status: 'adopted', adoptedAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(trialRevisions.id, input.trialRevisionId),
            eq(trialRevisions.status, 'published'),
          ))
          .returning({ id: trialRevisions.id });
        if (adopted.length !== 1) throw new UserBookError('试读版本已经失效', 409);
        const activated = await tx
          .update(userBooks)
          .set({ workflowStatus: 'active_reading', currentStrategyVersionId: strategy.id, updatedAt: new Date() })
          .where(and(
            eq(userBooks.id, userBookId),
            eq(userBooks.workflowStatus, 'trial_review'),
            eq(userBooks.currentTrialRevisionId, input.trialRevisionId),
            eq(userBooks.currentStrategyDraftVersionId, input.strategyDraftVersionId),
          ))
          .returning({ id: userBooks.id });
        if (activated.length !== 1) throw new UserBookError('试读状态已经更新', 409);
        return { strategy, created: true, generationIds };
      });
      if (!result.created) {
        await enqueuePendingFormalGenerations(userBookId);
        return { userBookId, workflowStatus: 'active_reading', strategyVersionId: result.strategy.id };
      }
      // Seed the initial window (first eligible node + lookahead) at the priority band so the
      // reader's opening nodes generate first; later scroll/jump 提权 flows through the same helper.
      // The rows are already committed, so a window failure falls back to the plain background
      // enqueue rather than introducing a new post-commit failure mode.
      try {
        await ensureFormalWindow(userBookId, result.strategy.id, owned.sharedBook.id, formalNodes[0]?.order ?? 1);
      } catch {
        await enqueuePendingFormalGenerations(userBookId);
      }
      return { userBookId, workflowStatus: 'active_reading', strategyVersionId: result.strategy.id };
    },

    async reader(userBookId: string): Promise<ReaderBootstrap> {
      const owned = await getOwnedBook(userBookId);
      if (owned.userBook.workflowStatus !== 'active_reading' || !owned.userBook.currentStrategyVersionId || !owned.userBook.currentStrategyDraftVersionId) {
        throw new UserBookError('尚未完成试读确认', 409);
      }
      try {
        await enqueuePendingFormalGenerations(userBookId);
      } catch {
        // Enhancement recovery must not block access to the original book.
      }
      try {
        // §6.2 / §11.5: continue the lazy-loading window from the resumed position (not only node
        // 1), so a reopened book keeps generating where the reader left off. Focus-report window
        // growth is gated on order change, so this on-load ensure covers a same-order reopen.
        // Best-effort — the original text is always available (§14.3).
        const [resume] = await db
          .select({ nodeOrder: readerStates.nodeOrder })
          .from(readerStates)
          .where(eq(readerStates.userBookId, userBookId))
          .limit(1);
        await ensureFormalWindow(
          userBookId,
          owned.userBook.currentStrategyVersionId,
          owned.sharedBook.id,
          resume?.nodeOrder ?? 1,
        );
      } catch {
        // Window maintenance is best-effort; a failed enqueue must not fail the read.
      }
      return buildReaderBootstrap(
        userBookId,
        owned.sharedBook.id,
        owned.userBook.currentStrategyVersionId,
        owned.userBook.currentStrategyDraftVersionId,
      );
    },

    async reportReaderFocus(userBookId: string, input: ReaderFocusRequest): Promise<ReaderBootstrap> {
      const owned = await getOwnedBook(userBookId);
      if (owned.userBook.workflowStatus !== 'active_reading' || !owned.userBook.currentStrategyVersionId || !owned.userBook.currentStrategyDraftVersionId) {
        throw new UserBookError('尚未完成试读确认', 409);
      }
      // The dedup 坑 (§4A/§2): the same focus signal now carries the finer reading position. So we
      // read the prior node order (to gate window growth) and always save the position — «order 变
      // 了才动窗口、位置总是存». Intra-node scroll updates the anchor without re-touching the window.
      const [prior] = await db
        .select({ nodeOrder: readerStates.nodeOrder })
        .from(readerStates)
        .where(eq(readerStates.userBookId, userBookId))
        .limit(1);
      if (input.position) {
        try {
          await persistReaderPosition(userBookId, owned.sharedBook.id, input.order, input.position);
        } catch {
          // Position save is best-effort; it must not block the read (§14.3).
        }
      }
      try {
        const meta = await getManifestMeta(options.books, owned.sharedBook.id);
        const focusedNode = meta.nodesByOrder.get(input.order);
        if (focusedNode) {
          await db.transaction(async (tx) => {
            // Serialize with proposal confirmation. Persisting the position first means that if
            // confirmation wins second, it sees and repins this same current node; if it wins first,
            // this transaction reads the newly committed strategy instead of writing a stale pin.
            const [freshBook] = await tx
              .select({
                workflowStatus: userBooks.workflowStatus,
                strategyVersionId: userBooks.currentStrategyVersionId,
              })
              .from(userBooks)
              .where(eq(userBooks.id, userBookId))
              .for('update')
              .limit(1);
            if (freshBook?.workflowStatus !== 'active_reading' || !freshBook.strategyVersionId) return;
            await tx
              .update(readerReadNodes)
              .set({ strategyVersionId: freshBook.strategyVersionId })
              .where(and(
                eq(readerReadNodes.userBookId, userBookId),
                eq(readerReadNodes.sectionId, focusedNode.sectionId),
                eq(readerReadNodes.segment, focusedNode.segment),
              ));
          });
        }
      } catch {
        // Pin maintenance is recoverable from the next focus/bootstrap.
      }
      if (!prior || prior.nodeOrder !== input.order) {
        try {
          // Grow/prioritize the lazy-loading window around the reader's position. Never let this
          // block the reader — the original text is always available regardless (§14.3).
          await ensureFormalWindow(
            userBookId,
            owned.userBook.currentStrategyVersionId,
            owned.sharedBook.id,
            input.order,
          );
        } catch {
          // Window maintenance is best-effort; a failed enqueue must not fail the read.
        }
      }
      return buildReaderBootstrap(
        userBookId,
        owned.sharedBook.id,
        owned.userBook.currentStrategyVersionId,
        owned.userBook.currentStrategyDraftVersionId,
      );
    },

    // §11.6 — the user's global reader settings. Read alongside bootstrap; this standalone getter
    // exists for symmetry with the PUT and is not required by the reader's happy path.
    async getReadingSettings(): Promise<ReadingSettingsResponse> {
      return { settings: await loadReadingSettings() };
    },

    async updateReadingSettings(settings: ReadingSettings): Promise<ReadingSettingsResponse> {
      await db
        .insert(userReadingSettings)
        .values({ userId, settings, updatedAt: new Date() })
        .onConflictDoUpdate({ target: userReadingSettings.userId, set: { settings, updatedAt: new Date() } });
      return { settings };
    },

    // §11.4 — mark a reading node read. Monotonic and idempotent: a re-mark (or a node that later
    // loses eligibility) never removes an existing entry. Returns the full set so the client can
    // reconcile its local view without a second round trip.
    async markReadNode(userBookId: string, input: MarkReadNodeRequest): Promise<MarkReadNodeResponse> {
      const owned = await getOwnedBook(userBookId);
      if (owned.userBook.workflowStatus !== 'active_reading') {
        throw new UserBookError('尚未完成试读确认', 409);
      }
      await db
        .insert(readerReadNodes)
        .values({
          userBookId,
          sectionId: input.sectionId,
          segment: input.segment,
          strategyVersionId: owned.userBook.currentStrategyVersionId!,
        })
        .onConflictDoNothing();
      const rows = await db
        .select({ sectionId: readerReadNodes.sectionId, segment: readerReadNodes.segment })
        .from(readerReadNodes)
        .where(eq(readerReadNodes.userBookId, userBookId));
      return { readNodes: rows.map((row) => ({ sectionId: row.sectionId, segment: row.segment })) };
    },

    // §11.7 — the book's highlights (standalone list; the reader gets them via bootstrap too).
    async listHighlights(userBookId: string): Promise<HighlightListResponse> {
      await getOwnedBook(userBookId);
      return { highlights: await loadHighlights(userBookId) };
    },

    // §11.7 — create a highlight (optionally with a note). Validates the range against the node's
    // actual blocks (same coordinate system as annotation anchors); an out-of-range range is rejected
    // outright, no fuzzy match. Captures the standard-text quote + manifest version at creation time.
    async createHighlight(userBookId: string, input: CreateHighlightRequest): Promise<HighlightResponse> {
      const owned = await getOwnedBook(userBookId);
      if (owned.userBook.workflowStatus !== 'active_reading') {
        throw new UserBookError('尚未完成试读确认', 409);
      }
      const { html } = await getManifestAndHtml(owned.sharedBook.id);
      let source;
      try {
        source = extractNodeSourceFromHtml(html, input.sectionId, input.segment);
      } catch {
        throw new UserBookError('划线引用的阅读节点不存在', 409);
      }
      assertRangeWithinBlocks(source.blocks, input.range, '划线');
      const note = input.note?.trim() ? input.note.trim() : null;
      const [row] = await db
        .insert(highlights)
        .values({
          userBookId,
          sectionId: input.sectionId,
          segment: input.segment,
          startBlockIndex: input.range.start.blockIndex,
          startOffset: input.range.start.offset,
          endBlockIndex: input.range.end.blockIndex,
          endOffset: input.range.end.offset,
          manifestVersion: (await getManifestMeta(options.books, owned.sharedBook.id)).version,
          note,
          quoteSnapshot: quoteFromBlocks(source.blocks, input.range),
        })
        .returning();
      return { highlight: mapHighlight(row!) };
    },

    // §11.7 — edit or clear a highlight's note. A blank/null note clears it but keeps the highlight
    // (delete-note ≠ delete-highlight). Ownership is enforced via getOwnedBook so a foreign book id
    // can't touch another user's row.
    async updateHighlightNote(
      userBookId: string,
      highlightId: string,
      input: UpdateHighlightNoteRequest,
    ): Promise<HighlightResponse> {
      await getOwnedBook(userBookId);
      const note = input.note?.trim() ? input.note.trim() : null;
      const [row] = await db
        .update(highlights)
        .set({ note, updatedAt: new Date() })
        .where(and(eq(highlights.id, highlightId), eq(highlights.userBookId, userBookId)))
        .returning();
      if (!row) throw new UserBookError('划线不存在', 404);
      return { highlight: mapHighlight(row) };
    },

    // §11.7 — delete a highlight (row + its note). Does not cascade to any 问 AI conversation, which
    // snapshots the origin range rather than referencing highlights.id (§12 开放问题 1).
    async deleteHighlight(userBookId: string, highlightId: string): Promise<DeleteHighlightResponse> {
      await getOwnedBook(userBookId);
      const [row] = await db
        .delete(highlights)
        .where(and(eq(highlights.id, highlightId), eq(highlights.userBookId, userBookId)))
        .returning({ id: highlights.id });
      if (!row) throw new UserBookError('划线不存在', 404);
      return { id: row.id };
    },

    // §11.8 — accumulate one effective reading interval. Idempotent by clientIntervalId (GREATEST
    // clamp), then the (user, day) rollup is recomputed as an exact SUM so retries / a pagehide flush
    // racing a periodic beat never double-count. Heartbeats only land during active reading (§11.8
    // 「位于正式阅读器」); a non-reading book is a 409.
    async recordHeartbeat(userBookId: string, input: HeartbeatRequest): Promise<HeartbeatResponse> {
      const owned = await getOwnedBook(userBookId);
      if (owned.userBook.workflowStatus !== 'active_reading') {
        throw new UserBookError('尚未完成试读确认', 409);
      }
      const now = new Date();
      const { startedAt, endedAt } = validateHeartbeat(input, now);
      await db.transaction(async (tx) => {
        await tx
          .insert(readingSessions)
          .values({
            userBookId,
            userId,
            clientIntervalId: input.clientIntervalId,
            day: input.day,
            startedAt,
            endedAt,
            effectiveSeconds: input.effectiveSeconds,
            forwardSeconds: input.forwardSeconds,
            forwardChars: input.forwardChars,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              readingSessions.userId,
              readingSessions.userBookId,
              readingSessions.clientIntervalId,
            ],
            set: {
              endedAt: sql`greatest(coalesce(${readingSessions.endedAt}, excluded.ended_at), excluded.ended_at)`,
              effectiveSeconds: sql`greatest(${readingSessions.effectiveSeconds}, ${input.effectiveSeconds})`,
              forwardSeconds: sql`greatest(${readingSessions.forwardSeconds}, ${input.forwardSeconds})`,
              forwardChars: sql`greatest(${readingSessions.forwardChars}, ${input.forwardChars})`,
              updatedAt: now,
            },
          });
        // Recompute the day's rollup across all of the user's books (the global daily total, §11.9 /
        // PRD :1204) from the just-clamped session values — an absolute SET, never an increment.
        const [rollup] = await tx
          .select({ total: sql<number>`coalesce(sum(${readingSessions.effectiveSeconds}), 0)::int` })
          .from(readingSessions)
          .where(and(eq(readingSessions.userId, userId), eq(readingSessions.day, input.day)));
        const total = rollup?.total ?? 0;
        await tx
          .insert(dailyReadingTotals)
          .values({ userId, day: input.day, effectiveSeconds: total, updatedAt: now })
          .onConflictDoUpdate({
            target: [dailyReadingTotals.userId, dailyReadingTotals.day],
            set: { effectiveSeconds: total, updatedAt: now },
          });
      });
      return { accepted: true };
    },

    async recordReadingActivitySlice(
      userBookId: string,
      input: ReadingActivitySliceRequest,
    ): Promise<ReadingActivitySliceResponse> {
      const owned = await getOwnedBook(userBookId);
      if (owned.userBook.workflowStatus !== 'active_reading') {
        throw new UserBookError('尚未完成试读确认', 409);
      }
      const now = new Date();
      const validated = validateReadingActivitySlice(input, now);
      const endedAtSql = sql`${validated.endedAt.toISOString()}::timestamptz`;
      const meta = await getManifestMeta(options.books, owned.sharedBook.id);
      const classified = classifyReadingActivitySlice(meta, input, validated.effectiveSeconds);
      const buckets = splitActivitySliceByLocalDay(validated.startedAt, validated.endedAt, input.timezone);
      const bucketForwardSeconds = allocateBySeconds(classified.forwardSeconds, buckets);
      const bucketForwardChars = allocateBySeconds(classified.forwardChars, buckets);

      await db.transaction(async (tx) => {
        const [session] = await tx
          .insert(readingSessions)
          .values({
            userBookId,
            userId,
            clientIntervalId: input.clientSessionId,
            day: validated.day,
            startedAt: validated.startedAt,
            endedAt: validated.endedAt,
            effectiveSeconds: 0,
            forwardSeconds: 0,
            forwardChars: 0,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              readingSessions.userId,
              readingSessions.userBookId,
              readingSessions.clientIntervalId,
            ],
            set: {
              startedAt: sql`least(${readingSessions.startedAt}, excluded.started_at)`,
              endedAt: sql`greatest(coalesce(${readingSessions.endedAt}, excluded.ended_at), excluded.ended_at)`,
              updatedAt: now,
            },
          })
          .returning({ id: readingSessions.id });
        if (!session) throw new UserBookError('阅读 session 写入失败', 503);

        const [inserted] = await tx
          .insert(readingActivitySlices)
          .values({
            readingSessionId: session.id,
            userBookId,
            userId,
            clientSessionId: input.clientSessionId,
            sequence: input.sequence,
            timezone: input.timezone,
            day: validated.day,
            startedAt: validated.startedAt,
            endedAt: validated.endedAt,
            startOrder: input.startPosition.order,
            startSectionId: input.startPosition.sectionId,
            startSegment: input.startPosition.segment,
            startBlockIndex: input.startPosition.blockIndex,
            startOffset: input.startPosition.offset,
            endOrder: input.endPosition.order,
            endSectionId: input.endPosition.sectionId,
            endSegment: input.endPosition.segment,
            endBlockIndex: input.endPosition.blockIndex,
            endOffset: input.endPosition.offset,
            activityArea: input.activityArea,
            classification: classified.classification,
            effectiveSeconds: validated.effectiveSeconds,
            forwardSeconds: classified.forwardSeconds,
            forwardChars: classified.forwardChars,
          })
          .onConflictDoNothing({
            target: [
              readingActivitySlices.userId,
              readingActivitySlices.clientSessionId,
              readingActivitySlices.sequence,
            ],
          })
          .returning({ id: readingActivitySlices.id });
        if (!inserted) return;

        await tx
          .update(readingSessions)
          .set({
            endedAt: sql`greatest(coalesce(${readingSessions.endedAt}, ${endedAtSql}), ${endedAtSql})`,
            effectiveSeconds: sql`${readingSessions.effectiveSeconds} + ${validated.effectiveSeconds}`,
            forwardSeconds: sql`${readingSessions.forwardSeconds} + ${classified.forwardSeconds}`,
            forwardChars: sql`${readingSessions.forwardChars} + ${classified.forwardChars}`,
            updatedAt: now,
          })
          .where(eq(readingSessions.id, session.id));

        for (const [index, bucket] of buckets.entries()) {
          if (bucket.effectiveSeconds <= 0) continue;
          const forwardSeconds = bucketForwardSeconds[index] ?? 0;
          const forwardChars = bucketForwardChars[index] ?? 0;
          await tx
            .insert(readingDailyBookStats)
            .values({
              userId,
              userBookId,
              day: bucket.day,
              effectiveSeconds: bucket.effectiveSeconds,
              forwardSeconds,
              forwardChars,
              lastReadAt: validated.endedAt,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [
                readingDailyBookStats.userId,
                readingDailyBookStats.userBookId,
                readingDailyBookStats.day,
              ],
              set: {
                effectiveSeconds: sql`${readingDailyBookStats.effectiveSeconds} + ${bucket.effectiveSeconds}`,
                forwardSeconds: sql`${readingDailyBookStats.forwardSeconds} + ${forwardSeconds}`,
                forwardChars: sql`${readingDailyBookStats.forwardChars} + ${forwardChars}`,
                lastReadAt: sql`greatest(coalesce(${readingDailyBookStats.lastReadAt}, excluded.last_read_at), excluded.last_read_at)`,
                updatedAt: now,
              },
            });
          await tx
            .insert(dailyReadingTotals)
            .values({
              userId,
              day: bucket.day,
              effectiveSeconds: bucket.effectiveSeconds,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [dailyReadingTotals.userId, dailyReadingTotals.day],
              set: {
                effectiveSeconds: sql`${dailyReadingTotals.effectiveSeconds} + ${bucket.effectiveSeconds}`,
                updatedAt: now,
              },
            });
        }

        if (validated.effectiveSeconds > 0) {
          await tx
            .insert(bookReadingStats)
            .values({
              userBookId,
              userId,
              effectiveSeconds: validated.effectiveSeconds,
              forwardSeconds: classified.forwardSeconds,
              forwardChars: classified.forwardChars,
              lastReadAt: validated.endedAt,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [bookReadingStats.userBookId],
              set: {
                effectiveSeconds: sql`${bookReadingStats.effectiveSeconds} + ${validated.effectiveSeconds}`,
                forwardSeconds: sql`${bookReadingStats.forwardSeconds} + ${classified.forwardSeconds}`,
                forwardChars: sql`${bookReadingStats.forwardChars} + ${classified.forwardChars}`,
                lastReadAt: sql`greatest(coalesce(${bookReadingStats.lastReadAt}, excluded.last_read_at), excluded.last_read_at)`,
                updatedAt: now,
              },
            });
        }
      });
      return { accepted: true };
    },

    // §11.9 global stats: 今日 / 本周 / 累计有效时长 + 当前连续阅读天数. Read entirely from the durable
    // daily rollup (survives book deletion, PRD :1204). `day`/`weekStart` come from the client so the
    // calendar boundaries honor its timezone; 'YYYY-MM-DD' compares chronologically as strings.
    async getGlobalReadingStats(query: ReadingStatsQuery): Promise<ReadingStatsGlobal> {
      validateReadingStatsQuery(query);
      const rows = await db
        .select({ day: dailyReadingTotals.day, effectiveSeconds: dailyReadingTotals.effectiveSeconds })
        .from(dailyReadingTotals)
        .where(eq(dailyReadingTotals.userId, userId));
      let todaySeconds = 0;
      let weekSeconds = 0;
      let totalSeconds = 0;
      const activeDays = new Set<string>();
      for (const row of rows) {
        totalSeconds += row.effectiveSeconds;
        if (row.effectiveSeconds > 0) activeDays.add(row.day);
        if (row.day === query.day) todaySeconds += row.effectiveSeconds;
        if (row.day >= query.weekStart && row.day <= query.day) weekSeconds += row.effectiveSeconds;
      }
      return { todaySeconds, weekSeconds, totalSeconds, streakDays: computeStreakDays(activeDays, query.day) };
    },

    // §11.9 per-book stats: 累计有效时长 / 最近阅读时间 / 全书进度 / 预计剩余时间. Progress uses the stored
    // stable position (reader_states) against the manifest's whole-node char counts; remaining time is
    // 剩余原文字符 ÷ speed, with the language default until the book's forward-reading sample is solid
    // (§11.10). Sessions are per-book, so this total dies with the book by design (PRD :1197).
    async getBookReadingStats(userBookId: string): Promise<ReadingStatsPerBook> {
      const owned = await getOwnedBook(userBookId);
      const [cached] = await db
        .select({
          totalEffective: bookReadingStats.effectiveSeconds,
          forwardSeconds: bookReadingStats.forwardSeconds,
          forwardChars: bookReadingStats.forwardChars,
          lastReadAt: bookReadingStats.lastReadAt,
        })
        .from(bookReadingStats)
        .where(eq(bookReadingStats.userBookId, userBookId))
        .limit(1);
      let agg = cached;
      if (!agg) {
        const [legacyAgg] = await db
          .select({
            totalEffective: sql<number>`coalesce(sum(${readingSessions.effectiveSeconds}), 0)::int`,
            forwardSeconds: sql<number>`coalesce(sum(${readingSessions.forwardSeconds}), 0)::int`,
            forwardChars: sql<number>`coalesce(sum(${readingSessions.forwardChars}), 0)::int`,
            lastReadAt: sql<Date | null>`max(${readingSessions.endedAt})`,
          })
          .from(readingSessions)
          .where(eq(readingSessions.userBookId, userBookId));
        agg = legacyAgg;
      }
      const [resume] = await db
        .select({ nodeOrder: readerStates.nodeOrder })
        .from(readerStates)
        .where(eq(readerStates.userBookId, userBookId))
        .limit(1);
      const meta = await getManifestMeta(options.books, owned.sharedBook.id);
      const progress = computeBookProgress(meta, resume?.nodeOrder ?? null);
      const speed = resolveReadingSpeed(meta.language, agg?.forwardSeconds ?? 0, agg?.forwardChars ?? 0);
      const remaining = progress.remainingChars === null
        ? { seconds: null, approximate: true }
        : {
          seconds: speed.charsPerSec > 0 ? Math.round(progress.remainingChars / speed.charsPerSec) : null,
          approximate: speed.approximate,
        };
      return {
        totalEffectiveSeconds: agg?.totalEffective ?? 0,
        lastReadAt: agg?.lastReadAt ? new Date(agg.lastReadAt).toISOString() : null,
        progressPercent: progress.progressPercent,
        remainingCharacters: progress.remainingChars,
        remaining,
      };
    },

    async listQaSessions(
      userBookId: string,
      cursor?: string,
      limit = 20,
    ): Promise<QaSessionListResponse> {
      await getOwnedBook(userBookId);
      const pageSize = Math.max(1, Math.min(limit, 50));
      const boundary = cursor ? decodeQaSessionCursor(cursor) : null;
      const boundaryAt = boundary ? new Date(boundary.updatedAt) : null;
      const rows = await db
        .select()
        .from(qaSessions)
        .where(and(
          eq(qaSessions.userBookId, userBookId),
          ...(boundary && boundaryAt
            ? [or(
                lt(qaSessions.updatedAt, boundaryAt),
                and(
                  eq(qaSessions.updatedAt, boundaryAt),
                  lt(qaSessions.id, boundary.sessionId),
                ),
              )!]
            : []),
        ))
        .orderBy(desc(qaSessions.updatedAt), desc(qaSessions.id))
        .limit(pageSize + 1);
      const page = rows.slice(0, pageSize);
      const sessions = await Promise.all(page.map(async (session) => {
        const messages = await db
          .select({ content: qaMessages.content, kind: qaMessages.kind })
          .from(qaMessages)
          .where(eq(qaMessages.qaSessionId, session.id))
          .orderBy(asc(qaMessages.sequence));
        return {
          sessionId: session.id,
          status: session.status,
          question: messages.find((message) => message.kind === 'question')?.content ?? '',
          updatedAt: session.updatedAt.toISOString(),
          messageCount: messages.length,
        };
      }));
      return {
        sessions,
        nextCursor: rows.length > pageSize
          ? encodeQaSessionCursor({
              updatedAt: page.at(-1)!.updatedAt.toISOString(),
              sessionId: page.at(-1)!.id,
            })
          : null,
      };
    },

    async feedbackProposal(
      userBookId: string,
      proposalId: string,
      input: ProposalFeedbackRequest,
    ): Promise<ProposalActionResponse> {
      await getOwnedBook(userBookId);
      const feedback = input.feedback.trim();
      if (!feedback) throw new UserBookError('反馈不能为空', 400);
      return db.transaction(async (tx) => {
        const [proposal] = await tx
          .select()
          .from(strategyChangeProposals)
          .where(and(
            eq(strategyChangeProposals.id, proposalId),
            eq(strategyChangeProposals.userBookId, userBookId),
          ))
          .for('update')
          .limit(1);
        if (!proposal) throw new UserBookError('处理方式建议不存在', 404);
        const payload = { revisionId: input.revisionId, feedback };
        const [existing] = await tx
          .select()
          .from(strategyChangeProposalActions)
          .where(and(
            eq(strategyChangeProposalActions.proposalId, proposalId),
            eq(strategyChangeProposalActions.idempotencyKey, input.idempotencyKey),
          ))
          .limit(1);
        if (existing) return replayProposalAction(existing, 'feedback', input.revisionId, payload);
        if (
          proposal.status !== 'pending'
          || proposal.currentRevisionId !== input.revisionId
        ) {
          throw new UserBookError('该建议修订已经失效', 409);
        }
        const result: ProposalActionResponse = {
          proposalId,
          revisionId: input.revisionId,
          status: 'pending',
          resultingStrategyVersionId: null,
        };
        await tx
          .update(strategyChangeProposals)
          .set({ feedback, updatedAt: new Date() })
          .where(eq(strategyChangeProposals.id, proposalId));
        await tx.insert(strategyChangeProposalActions).values({
          proposalId,
          revisionId: input.revisionId,
          action: 'feedback',
          payload,
          result,
          idempotencyKey: input.idempotencyKey,
        });
        return result;
      });
    },

    async rejectProposal(
      userBookId: string,
      proposalId: string,
      input: ProposalDecisionRequest,
    ): Promise<ProposalActionResponse> {
      await getOwnedBook(userBookId);
      return db.transaction(async (tx) => {
        const [proposal] = await tx
          .select()
          .from(strategyChangeProposals)
          .where(and(
            eq(strategyChangeProposals.id, proposalId),
            eq(strategyChangeProposals.userBookId, userBookId),
          ))
          .for('update')
          .limit(1);
        if (!proposal) throw new UserBookError('处理方式建议不存在', 404);
        const payload = { revisionId: input.revisionId };
        const [existing] = await tx
          .select()
          .from(strategyChangeProposalActions)
          .where(and(
            eq(strategyChangeProposalActions.proposalId, proposalId),
            eq(strategyChangeProposalActions.idempotencyKey, input.idempotencyKey),
          ))
          .limit(1);
        if (existing) return replayProposalAction(existing, 'reject', input.revisionId, payload);
        if (
          proposal.status !== 'pending'
          || proposal.currentRevisionId !== input.revisionId
        ) {
          throw new UserBookError('该建议修订已经失效', 409);
        }
        const result: ProposalActionResponse = {
          proposalId,
          revisionId: input.revisionId,
          status: 'rejected',
          resultingStrategyVersionId: null,
        };
        await tx
          .update(strategyDraftVersions)
          .set({ status: 'superseded', supersededAt: new Date() })
          .where(and(
            eq(strategyDraftVersions.id, proposal.currentStrategyDraftVersionId),
            eq(strategyDraftVersions.status, 'draft'),
          ));
        const changed = await tx
          .update(strategyChangeProposals)
          .set({ status: 'rejected', rejectedAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(strategyChangeProposals.id, proposalId),
            eq(strategyChangeProposals.status, 'pending'),
            eq(strategyChangeProposals.currentRevisionId, input.revisionId),
          ))
          .returning({ id: strategyChangeProposals.id });
        if (changed.length !== 1) throw new UserBookError('该建议修订已经失效', 409);
        await tx.insert(strategyChangeProposalActions).values({
          proposalId,
          revisionId: input.revisionId,
          action: 'reject',
          payload,
          result,
          idempotencyKey: input.idempotencyKey,
        });
        return result;
      });
    },

    async confirmProposal(
      userBookId: string,
      proposalId: string,
      input: ProposalDecisionRequest,
    ): Promise<ProposalActionResponse> {
      const owned = await getOwnedBook(userBookId);
      const { manifest } = await getManifestAndHtml(owned.sharedBook.id);
      const result = await db.transaction(async (tx) => {
        const [book] = await tx
          .select()
          .from(userBooks)
          .where(eq(userBooks.id, userBookId))
          .for('update')
          .limit(1);
        const [proposal] = await tx
          .select()
          .from(strategyChangeProposals)
          .where(and(
            eq(strategyChangeProposals.id, proposalId),
            eq(strategyChangeProposals.userBookId, userBookId),
          ))
          .for('update')
          .limit(1);
        if (!book || !proposal) throw new UserBookError('处理方式建议不存在', 404);
        const payload = { revisionId: input.revisionId };
        const [existing] = await tx
          .select()
          .from(strategyChangeProposalActions)
          .where(and(
            eq(strategyChangeProposalActions.proposalId, proposalId),
            eq(strategyChangeProposalActions.idempotencyKey, input.idempotencyKey),
          ))
          .limit(1);
        if (existing) {
          return {
            response: replayProposalAction(existing, 'confirm', input.revisionId, payload),
            generations: [] as Array<{ id: string; priority: number }>,
          };
        }
        if (
          book.workflowStatus !== 'active_reading'
          || !book.currentStrategyVersionId
          || proposal.status !== 'pending'
          || proposal.currentRevisionId !== input.revisionId
          || proposal.baseStrategyVersionId !== book.currentStrategyVersionId
        ) {
          throw new UserBookError('该建议基于的处理方式已经变化，请重新提出建议', 409);
        }
        const [revision] = await tx
          .select()
          .from(strategyChangeProposalRevisions)
          .where(and(
            eq(strategyChangeProposalRevisions.id, input.revisionId),
            eq(strategyChangeProposalRevisions.proposalId, proposalId),
          ))
          .limit(1);
        if (!revision || revision.strategyDraftVersionId !== proposal.currentStrategyDraftVersionId) {
          throw new UserBookError('该建议修订已经失效', 409);
        }
        const [draft] = await tx
          .update(strategyDraftVersions)
          .set({ status: 'confirmed', confirmedAt: new Date() })
          .where(and(
            eq(strategyDraftVersions.id, proposal.currentStrategyDraftVersionId),
            eq(strategyDraftVersions.userBookId, userBookId),
            eq(strategyDraftVersions.status, 'draft'),
          ))
          .returning();
        if (!draft) throw new UserBookError('候选处理方式已经失效', 409);
        const [versionRow] = await tx
          .select({
            nextVersion: sql<number>`coalesce(max(${strategyVersions.version}), 0)::int + 1`,
          })
          .from(strategyVersions)
          .where(eq(strategyVersions.userBookId, userBookId));
        const nextVersion = versionRow?.nextVersion ?? 1;
        const [strategy] = await tx
          .insert(strategyVersions)
          .values({
            userBookId,
            sourceDraftVersionId: draft.id,
            version: nextVersion,
            userFacingSummary: draft.userFacingSummary,
            strategy: draft.strategy,
          })
          .returning();
        if (!strategy) throw new UserBookError('正式处理方式创建失败', 503);
        const [state] = await tx
          .select()
          .from(readerStates)
          .where(eq(readerStates.userBookId, userBookId))
          .for('update')
          .limit(1);
        const currentNode = manifest.nodes.find((node) =>
          state
            ? node.section_id === state.sectionId && node.segment === state.segment
            : node.section_id === proposal.originSectionId && node.segment === proposal.originSegment,
        ) ?? manifest.nodes.find((node) =>
          node.section_id === proposal.originSectionId && node.segment === proposal.originSegment,
        ) ?? manifest.nodes[0];
        if (!currentNode) throw new UserBookError('书籍没有可阅读节点', 409);
        const eligible = manifest.nodes
          .filter((node) => node.tailoring_eligible)
          .sort((left, right) => left.order - right.order);
        const ahead = eligible
          .filter((node) => node.order >= currentNode.order)
          .slice(0, FORMAL_WINDOW_SIZE);
        const window = ahead.length > 0 ? ahead : eligible.slice(-FORMAL_WINDOW_SIZE);
        const switched = await tx
          .update(userBooks)
          .set({
            currentStrategyVersionId: strategy.id,
            currentStrategyDraftVersionId: draft.id,
            updatedAt: new Date(),
          })
          .where(and(
            eq(userBooks.id, userBookId),
            eq(userBooks.workflowStatus, 'active_reading'),
            eq(userBooks.currentStrategyVersionId, proposal.baseStrategyVersionId),
          ))
          .returning({ id: userBooks.id });
        if (switched.length !== 1) throw new UserBookError('正式处理方式已经变化', 409);
        await tx
          .update(readerReadNodes)
          .set({ strategyVersionId: strategy.id })
          .where(and(
            eq(readerReadNodes.userBookId, userBookId),
            eq(readerReadNodes.sectionId, currentNode.section_id),
            eq(readerReadNodes.segment, currentNode.segment),
          ));
        const readRows = await tx
          .select()
          .from(readerReadNodes)
          .where(eq(readerReadNodes.userBookId, userBookId));
        const preservedReadKeys = new Set(
          readRows
            .filter((row) =>
              row.sectionId !== currentNode.section_id || row.segment !== currentNode.segment,
            )
            .map((row) => `${row.sectionId}\0${row.segment}`),
        );
        const obsolete = await tx
          .select({
            id: nodeGenerations.id,
            sectionId: nodeGenerations.sectionId,
            segment: nodeGenerations.segment,
          })
          .from(nodeGenerations)
          .where(and(
            eq(nodeGenerations.userBookId, userBookId),
            eq(nodeGenerations.generationScope, 'formal'),
            inArray(nodeGenerations.status, ['queued', 'retrying', 'generating']),
          ));
        const obsoleteIds = obsolete
          .filter((generation) =>
            !preservedReadKeys.has(`${generation.sectionId}\0${generation.segment}`),
          )
          .map((generation) => generation.id);
        if (obsoleteIds.length > 0) {
          await tx
            .update(nodeGenerations)
            .set({ status: 'superseded', result: null, completedAt: new Date(), updatedAt: new Date() })
            .where(inArray(nodeGenerations.id, obsoleteIds));
        }
        if (window.length > 0) {
          await tx
            .insert(nodeGenerations)
            .values(window.map((node) => {
              const id = randomUUID();
              return {
                id,
                userBookId,
                generationScope: 'formal' as const,
                strategyVersionId: strategy.id,
                sectionId: node.section_id,
                segment: node.segment,
                status: 'queued' as const,
                modelConfigId: options.modelConfigId,
                promptVersion: 'tailoring-content-1.0',
                cacheKey: `pending:${id}`,
              };
            }))
            .onConflictDoNothing();
        }
        const queued = window.length === 0
          ? []
          : await tx
              .select({
                id: nodeGenerations.id,
                sectionId: nodeGenerations.sectionId,
                segment: nodeGenerations.segment,
              })
              .from(nodeGenerations)
              .where(and(
                eq(nodeGenerations.userBookId, userBookId),
                eq(nodeGenerations.generationScope, 'formal'),
                eq(nodeGenerations.strategyVersionId, strategy.id),
                inArray(nodeGenerations.status, ['queued', 'retrying']),
              ));
        const priorityByKey = new Map(
          window.map((node, index) => [`${node.section_id}\0${node.segment}`, index + 1]),
        );
        const response: ProposalActionResponse = {
          proposalId,
          revisionId: input.revisionId,
          status: 'confirmed',
          resultingStrategyVersionId: strategy.id,
        };
        const confirmed = await tx
          .update(strategyChangeProposals)
          .set({
            status: 'confirmed',
            confirmedAt: new Date(),
            resultingStrategyVersionId: strategy.id,
            updatedAt: new Date(),
          })
          .where(and(
            eq(strategyChangeProposals.id, proposalId),
            eq(strategyChangeProposals.status, 'pending'),
            eq(strategyChangeProposals.currentRevisionId, input.revisionId),
          ))
          .returning({ id: strategyChangeProposals.id });
        if (confirmed.length !== 1) throw new UserBookError('该建议修订已经失效', 409);
        await tx.insert(strategyChangeProposalActions).values({
          proposalId,
          revisionId: input.revisionId,
          action: 'confirm',
          payload,
          result: response,
          idempotencyKey: input.idempotencyKey,
        });
        return {
          response,
          generations: queued.map((generation) => ({
            id: generation.id,
            priority: priorityByKey.get(`${generation.sectionId}\0${generation.segment}`)
              ?? FORMAL_BACKGROUND_PRIORITY,
          })),
        };
      });
      await Promise.allSettled(result.generations.map((generation) =>
        options.generations.enqueue({
          generationId: generation.id,
          userBookId,
          scope: 'formal',
          priority: generation.priority,
        }),
      ));
      return result.response;
    },

    // §8 问 AI streaming endpoint. Commits the question, then runs one turn, bridging the agent's
    // answer deltas and (pending) proposal event onto the SSE stream; persists the answer after
    // the turn. `session` is emitted first so the client learns the thread id for follow-ups.
    async *streamQaAnswer(
      userBookId: string,
      input: AskQuestionRequest,
    ): AsyncGenerator<QaStreamEvent> {
      const committed = await commitQaQuestion(userBookId, input);
      yield {
        type: 'session',
        sessionId: committed.sessionId,
        conversationVersion: committed.questionSequence,
      };
      // Idempotent replay / recovery: if this question already has its answer, re-emit it and
      // stop (a retry of an answered question must not run a second turn).
      const existing = await findQaAnswer(committed.sessionId, committed.questionSequence);
      if (existing) {
        yield { type: 'answer_delta', chars: existing.content };
        yield { type: 'done', sessionId: committed.sessionId, messageId: existing.id };
        return;
      }
      const { manifest, html } = await getManifestAndHtml(committed.owned.sharedBook.id);
      const normalizedContext = normalizeQaQuestionContext(
        committed.questionContext as unknown as Record<string, unknown>,
        manifest,
        html,
        false,
      ).context;
      const toolbox = buildAskAiToolbox(committed.owned, normalizedContext, manifest, html);
      const context = await buildQaContext(
        committed.sessionId,
        normalizedContext,
        committed.questionSequence,
      );
      const bridge = createStreamBridge<QaStreamEvent>();
      let turnError: unknown;
      let outcome: AskAiOutcome | undefined;
      const running = options.askAiEngine
        .runTurn({
          sessionId: committed.sessionId,
          question: committed.question,
          ...(requestContext.requestId ? { requestId: requestContext.requestId } : {}),
          conversationVersion: committed.questionSequence,
          context,
          toolbox,
          onAnswerDelta: (chars) => bridge.push({ type: 'answer_delta', chars }),
          onToolEvent: (event) => bridge.push(event),
        })
        .then((result) => {
          outcome = result;
        })
        .catch((error: unknown) => {
          turnError = error;
        })
        .finally(() => bridge.end());
      for await (const event of bridge.drain()) yield event;
      await running;
      if (turnError || !outcome) {
        yield {
          type: 'error',
          message: turnError instanceof UserBookError ? turnError.message : '回答生成失败，请稍后重试。',
        };
        return;
      }
      // Persist AFTER the turn (§8 atomicity): a mid-stream failure leaves the question row and no
      // answer, so a retry re-runs the turn. A concurrent duplicate turn loses the CAS (409); in
      // that case replay the winner's persisted answer instead of surfacing an error.
      try {
        const saved = await saveQaAnswer(
          userBookId,
          committed.sessionId,
          committed.questionSequence,
          committed.question,
          outcome,
          committed.owned.userBook.currentStrategyVersionId,
        );
        if (saved.proposal) yield { type: 'proposal', ...saved.proposal };
        if (saved.profileUpdated) yield { type: 'profile_updated' };
        yield { type: 'done', sessionId: committed.sessionId, messageId: saved.messageId };
      } catch (error) {
        const winner = await findQaAnswer(committed.sessionId, committed.questionSequence);
        if (winner) {
          yield { type: 'done', sessionId: committed.sessionId, messageId: winner.id };
          return;
        }
        yield {
          type: 'error',
          message: error instanceof UserBookError ? error.message : '回答保存失败，请稍后重试。',
        };
      }
    },

    // §8 — the persisted transcript of one question thread (reload/history). Proposal revisions
    // are attached to the assistant messages that created them.
    async qaSession(userBookId: string, sessionId: string): Promise<QaSessionResponse> {
      const owned = await getOwnedBook(userBookId);
      const [session] = await db
        .select()
        .from(qaSessions)
        .where(and(eq(qaSessions.id, sessionId), eq(qaSessions.userBookId, userBookId)))
        .limit(1);
      if (!session) throw new UserBookError('问答会话不存在', 404);
      const [messages, proposals, revisionRows, source] = await Promise.all([
        db
          .select()
          .from(qaMessages)
          .where(eq(qaMessages.qaSessionId, sessionId))
          .orderBy(asc(qaMessages.sequence)),
        db
          .select()
          .from(strategyChangeProposals)
          .where(eq(strategyChangeProposals.qaSessionId, sessionId))
          .orderBy(desc(strategyChangeProposals.createdAt)),
        db
          .select({
            revision: strategyChangeProposalRevisions,
            proposal: strategyChangeProposals,
          })
          .from(strategyChangeProposalRevisions)
          .innerJoin(
            strategyChangeProposals,
            eq(strategyChangeProposals.id, strategyChangeProposalRevisions.proposalId),
          )
          .where(eq(strategyChangeProposals.qaSessionId, sessionId)),
        getManifestAndHtml(owned.sharedBook.id),
      ]);
      const normalized = normalizeQaQuestionContext(
        session.questionContext,
        source.manifest,
        source.html,
        false,
      );
      const revisionsByMessage = new Map(
        revisionRows.map(({ revision, proposal }) => [
          revision.triggeringMessageId,
          {
            id: revision.id,
            proposalId: proposal.id,
            revision: revision.revision,
            triggeringMessageId: revision.triggeringMessageId,
            strategyDraftVersionId: revision.strategyDraftVersionId,
            publicSummary: revision.publicSummary,
            changedFields: revision.changedFields,
            reason: revision.reason,
            evidence: revision.evidence,
            status:
              proposal.currentRevisionId === revision.id
                ? proposal.status
                : ('superseded' as const),
            createdAt: revision.createdAt.toISOString(),
          },
        ]),
      );
      const proposal = proposals[0];
      return {
        sessionId,
        status: session.status,
        conversationVersion: session.conversationVersion,
        questionContext: normalized.context,
        contextPrecision: normalized.precision,
        messages: messages.map((message) => ({
          id: message.id,
          sequence: message.sequence,
          role: message.role,
          kind: message.kind,
          content: message.content,
          createdAt: message.createdAt.toISOString(),
          proposalRevision: revisionsByMessage.get(message.id) ?? null,
        })),
        proposal: proposal && proposal.currentRevisionId
          ? {
              id: proposal.id,
              status: proposal.status,
              publicSummary: proposal.publicSummary,
              revision: proposal.revision,
              currentRevisionId: proposal.currentRevisionId,
              currentStrategyDraftVersionId: proposal.currentStrategyDraftVersionId,
              baseStrategyVersionId: proposal.baseStrategyVersionId,
              resultingStrategyVersionId: proposal.resultingStrategyVersionId,
              createdAt: proposal.createdAt.toISOString(),
            }
          : null,
      };
    },
  };
}

export type UserBookService = ReturnType<typeof createUserBookService>;
export type UserBookUserService = ReturnType<typeof createUserBookServiceForUser>;
