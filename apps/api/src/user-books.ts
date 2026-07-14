import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  AdoptTrialRequest,
  AdoptTrialResponse,
  ApproveStrategyRequest,
  ApproveStrategyResponse,
  BookReaderProfile,
  InterviewQuestion,
  InterviewStateResponse,
  InterviewStreamEvent,
  MarkReadNodeRequest,
  MarkReadNodeResponse,
  MarkTrialSegmentViewedRequest,
  ReaderBootstrap,
  ReaderFocusRequest,
  ReaderPosition,
  ReaderProfile,
  ReadingSettings,
  ReadingSettingsResponse,
  Strategy,
  StrategyReviewResponse,
  TextRange,
  TrialCandidate,
  SubmitInterviewAnswerRequest,
  SubmitStrategyFeedbackRequest,
  SubmitTrialFeedbackRequest,
  TrialReviewResponse,
  UserBookShelfItem,
  UserBookShelfResponse,
  UserBookWorkflowResponse,
} from '@readtailor/contracts';
import { DEFAULT_READING_SETTINGS } from '@readtailor/contracts';
import {
  bookPackages,
  bookReaderProfileVersions,
  interviewAnswers,
  interviewMessages,
  interviewSessions,
  nodeGenerations,
  readerProfiles,
  readerProfileVersions,
  readerReadNodes,
  readerStates,
  sharedBooks,
  strategyDraftVersions,
  strategyVersions,
  trialRevisions,
  trialSegments,
  userBooks,
  userReadingSettings,
  type Database,
} from '@readtailor/database';
import { extractNodeSourceFromHtml, sliceNodeSource } from '@readtailor/tailoring';
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

type ManifestBlock = {
  block_index: number;
  block_utf16_length: number;
};

type ManifestNode = {
  section_id: string;
  segment: number;
  order: number;
  title?: string;
  parent_section_id?: string | null;
  tailoring_eligible: boolean;
  blocks: ManifestBlock[];
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

// A concurrent duplicate feedback (same idempotency key) loses the race on the partial unique
// index `interview_messages_feedback_idempotency_unique`. Surfacing that as an idempotent
// success — rather than a 500 — is the DB-level backstop behind the fast-path pre-check (§6.5).
// postgres-js exposes the Postgres unique-violation as code 23505 with the index name in
// `constraint_name`; check the wrapped cause too in case a driver layer re-throws.
function isFeedbackIdempotencyConflict(error: unknown): boolean {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  return candidates.some((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const pg = candidate as { code?: unknown; constraint_name?: unknown };
    return pg.code === '23505' && pg.constraint_name === 'interview_messages_feedback_idempotency_unique';
  });
}

function asManifest(value: unknown): ReadingManifest {
  const manifest = value as Partial<ReadingManifest>;
  if (!Array.isArray(manifest.nodes) || !Array.isArray(manifest.outline)) {
    throw new UserBookError('书籍阅读索引不可用', 409);
  }
  return manifest as ReadingManifest;
}

// The manifest is immutable per (immutable) book package, so memoize its position-relevant metadata
// per process. The position-save path (§11.5) stamps `version` onto every reader_states row for
// future migration识别 and validates the reported `order` against `nodesByOrder` (§4.3) — but it runs
// on each scroll settle, so it must not re-read the manifest artifact each time.
export interface ManifestMeta {
  version: string | null;
  nodesByOrder: Map<number, { sectionId: string; segment: number }>;
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
  let meta: ManifestMeta = { version: null, nodesByOrder: new Map() };
  try {
    const raw = (await books.getManifest(sharedBookId)) as { version?: unknown; nodes?: unknown } | null;
    const nodesByOrder = new Map<number, { sectionId: string; segment: number }>();
    if (Array.isArray(raw?.nodes)) {
      for (const node of raw.nodes as ManifestNode[]) {
        if (typeof node?.order === 'number' && typeof node?.section_id === 'string' && typeof node?.segment === 'number') {
          nodesByOrder.set(node.order, { sectionId: node.section_id, segment: node.segment });
        }
      }
    }
    meta = { version: typeof raw?.version === 'string' ? raw.version : null, nodesByOrder };
  } catch {
    meta = { version: null, nodesByOrder: new Map() };
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

// select_trial_fragments (§3.5) supersedes the mechanical first-six-blocks rangeForNode:
// the agent picks a real block range per node, so the host only maps snake_case → camelCase
// and validates the range against the node's actual blocks.
function mapFragments(fragments: Array<{
  section_id: string;
  segment: number;
  tag: 'threshold' | 'typical' | 'hardest';
  range: { start: { block_index: number; offset: number }; end: { block_index: number; offset: number } };
  reason: string;
}>): TrialCandidate[] {
  return fragments.map((fragment) => ({
    sectionId: fragment.section_id,
    segment: fragment.segment,
    reason: fragment.reason,
    tag: fragment.tag,
    range: {
      start: { blockIndex: fragment.range.start.block_index, offset: fragment.range.start.offset },
      end: { blockIndex: fragment.range.end.block_index, offset: fragment.range.end.offset },
    },
  }));
}

function assertRangeWithinBlocks(
  blocks: Array<{ block_index: number; text: string }>,
  range: TextRange,
) {
  const byIndex = new Map(blocks.map((block) => [block.block_index, block]));
  const startBlock = byIndex.get(range.start.blockIndex);
  const endBlock = byIndex.get(range.end.blockIndex);
  if (!startBlock || !endBlock || range.start.blockIndex > range.end.blockIndex) {
    throw new UserBookError('试读片段范围超出候选节点', 409);
  }
  if (range.start.offset < 0 || range.start.offset > startBlock.text.length) {
    throw new UserBookError('试读片段起点越界', 409);
  }
  if (range.end.offset < 0 || range.end.offset > endBlock.text.length) {
    throw new UserBookError('试读片段终点越界', 409);
  }
  if (range.start.blockIndex === range.end.blockIndex && range.start.offset >= range.end.offset) {
    throw new UserBookError('试读片段范围为空', 409);
  }
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
  generations: ContentGenerationEnqueuer;
  modelConfigId: string;
};

export function createUserBookService(options: UserBookServiceOptions) {
  return {
    forUser(userId: string) {
      return createUserBookServiceForUser(options, userId);
    },
  };
}

function createUserBookServiceForUser(options: UserBookServiceOptions, userId: string) {
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

  const saveSetupOutcome = async (
    userBookId: string,
    sessionId: string,
    outcome: Awaited<ReturnType<ReadingSetupEngine['runTurn']>>,
    expected: { questionCount: number; conversationVersion: number },
  ) => {
    if (outcome.type === 'question') {
      await db.transaction(async (tx) => {
        const sequence = expected.conversationVersion + 1;
        const advanced = await tx
          .update(interviewSessions)
          .set({
            questionCount: expected.questionCount + 1,
            conversationVersion: sequence,
            updatedAt: new Date(),
          })
          .where(and(
            eq(interviewSessions.id, sessionId),
            eq(interviewSessions.status, 'active'),
            eq(interviewSessions.questionCount, expected.questionCount),
            eq(interviewSessions.conversationVersion, expected.conversationVersion),
          ))
          .returning({ id: interviewSessions.id });
        if (advanced.length !== 1) return;
        await tx.insert(interviewMessages).values({
          interviewSessionId: sessionId,
          sequence,
          role: 'assistant',
          kind: 'question',
          content: outcome.question.prompt,
          payload: mapQuestion(outcome.question),
        });
      });
      return;
    }
    if (outcome.type !== 'completed') return;
    await db.transaction(async (tx) => {
      const completed = await tx
        .update(interviewSessions)
        .set({ status: 'completed', completedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(interviewSessions.id, sessionId),
          eq(interviewSessions.status, 'active'),
          eq(interviewSessions.questionCount, expected.questionCount),
          eq(interviewSessions.conversationVersion, expected.conversationVersion),
        ))
        .returning({ id: interviewSessions.id });
      if (completed.length !== 1) return;
      const [profile] = await tx
        .insert(bookReaderProfileVersions)
        .values({
          userBookId,
          interviewSessionId: sessionId,
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
          readingBriefing: outcome.briefing,
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
          const nextProfile: ReaderProfile = {
            ...reader.version.profile,
            knowledge: [...new Set([
              ...reader.version.profile.knowledge,
              ...(outcome.readerProfilePatch.knowledge ?? []),
            ])],
            explanationPreferences: [...new Set([
              ...reader.version.profile.explanationPreferences,
              ...(outcome.readerProfilePatch.explanation_preferences ?? []),
            ])],
          };
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
    });
  };

  // Runs one interviewing turn (agent → next question or finish) and commits its outcome.
  // Shared by the non-streaming recovery path (ensureInterview) and the streaming answer
  // endpoint, which additionally passes `onStream` to receive token-level deltas.
  const generateNextQuestion = async (
    userBookId: string,
    sessionId: string,
    session: { questionCount: number; conversationVersion: number },
    onStream?: (delta: InterviewStreamEvent) => void,
  ) => {
    const setup = await getSetupContext(userBookId);
    const outcome = await options.setupEngine.runTurn({
      sessionId,
      phase: 'interviewing',
      askedCount: session.questionCount,
      context: setup.context,
      ...(onStream ? { onStream } : {}),
    });
    await saveSetupOutcome(userBookId, sessionId, outcome, {
      questionCount: session.questionCount,
      conversationVersion: session.conversationVersion,
    });
    return outcome;
  };

  const ensureInterview = async (userBookId: string) => {
    const owned = await getOwnedBook(userBookId);
    if (owned.sharedBook.status !== 'ready') throw new UserBookError('书籍尚未处理完成', 409);
    if (!['on_shelf', 'interviewing'].includes(owned.userBook.workflowStatus)) return;
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
    const [session] = await db.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId)).limit(1);
    if (!session || session.status !== 'active') return;
    const [lastQuestion] = await db
      .select()
      .from(interviewMessages)
      .where(and(eq(interviewMessages.interviewSessionId, sessionId), eq(interviewMessages.kind, 'question')))
      .orderBy(desc(interviewMessages.sequence))
      .limit(1);
    const answered = lastQuestion
      ? await db.select({ id: interviewAnswers.id }).from(interviewAnswers).where(eq(interviewAnswers.questionMessageId, lastQuestion.id)).limit(1)
      : [];
    if (lastQuestion && answered.length === 0) return;
    await generateNextQuestion(userBookId, sessionId, session);
  };

  // Read-only projection of the persisted interview — no `ensureInterview` side effects, so
  // the streaming path can emit a terminal event from committed state without kicking off a
  // second (non-streamed) agent turn.
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

  const interviewState = async (userBookId: string): Promise<InterviewStateResponse> => {
    await ensureInterview(userBookId);
    return readInterviewState(userBookId);
  };

  // Validates and persists one answer (§4.1 step 1), idempotent on idempotencyKey. The
  // answer lands in its own transaction before any agent turn so a stream that dies later is
  // recoverable — a subsequent GET /interview simply re-runs the turn. `inserted` is false on
  // an idempotent replay, in which case the caller skips the turn.
  const commitInterviewAnswer = async (
    userBookId: string,
    input: SubmitInterviewAnswerRequest,
  ): Promise<{ inserted: boolean; sessionId: string }> => {
    const state = await interviewState(userBookId);
    if (state.status !== 'active' || !state.currentQuestion) throw new UserBookError('当前没有可回答的问题', 409);
    if (state.currentQuestion.id !== input.questionId) throw new UserBookError('问题已经更新，请刷新后继续', 409);
    const selected = new Set(input.selectedOptionIds);
    if (input.selectedOptionIds.some((id) => !state.currentQuestion!.options.some((option) => option.id === id))) {
      throw new UserBookError('回答包含无效选项', 400);
    }
    if (selected.size === 0 && !input.freeText?.trim()) throw new UserBookError('请选择一个选项或填写补充内容', 400);
    const [questionMessage] = await db
      .select()
      .from(interviewMessages)
      .where(and(eq(interviewMessages.interviewSessionId, state.sessionId), sql`${interviewMessages.payload}->>'id' = ${input.questionId}`))
      .limit(1);
    if (!questionMessage) throw new UserBookError('当前问题不存在', 409);
    const inserted = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(interviewAnswers)
        .where(and(eq(interviewAnswers.interviewSessionId, state.sessionId), eq(interviewAnswers.idempotencyKey, input.idempotencyKey)))
        .limit(1);
      if (existing) return false;
      const [session] = await tx.select().from(interviewSessions).where(eq(interviewSessions.id, state.sessionId)).limit(1);
      if (!session || session.status !== 'active') throw new UserBookError('访谈状态已经变化', 409);
      await tx.insert(interviewAnswers).values({
        interviewSessionId: state.sessionId,
        questionMessageId: questionMessage.id,
        selectedOptionIds: input.selectedOptionIds,
        freeText: input.freeText?.trim() || null,
        idempotencyKey: input.idempotencyKey,
      });
      const labels = state.currentQuestion!.options.filter((option) => selected.has(option.id)).map((option) => option.label);
      const content = [...labels, input.freeText?.trim()].filter(Boolean).join('；');
      await tx.insert(interviewMessages).values({
        interviewSessionId: state.sessionId,
        sequence: session.conversationVersion + 1,
        role: 'user',
        kind: 'answer',
        content,
        payload: input,
      });
      await tx.update(interviewSessions).set({ conversationVersion: session.conversationVersion + 1, updatedAt: new Date() }).where(eq(interviewSessions.id, state.sessionId));
      return true;
    });
    return { inserted, sessionId: state.sessionId };
  };

  // Closes a streamed turn (§4.2): once the turn is committed, emit the authoritative next
  // question, or `done` with the new workflow status when the interview finished. Reads from
  // persisted state (not this turn's outcome) so it stays correct under a concurrent turn.
  const terminalInterviewEvents = async function* (userBookId: string): AsyncGenerator<InterviewStreamEvent> {
    const owned = await getOwnedBook(userBookId);
    if (owned.userBook.workflowStatus !== 'interviewing') {
      yield { type: 'done', workflowStatus: owned.userBook.workflowStatus };
      return;
    }
    const state = await readInterviewState(userBookId);
    if (state.currentQuestion) {
      yield {
        type: 'question_final',
        question: state.currentQuestion,
        ordinal: Math.max(1, Math.min(state.maxQuestions, state.questionCount)),
        maxQuestions: state.maxQuestions,
      };
    } else {
      // No question yet (a concurrent turn, or a turn that produced nothing) — tell the client
      // to fall back to GET /interview.
      yield { type: 'done', workflowStatus: owned.userBook.workflowStatus };
    }
  };

  const strategyState = async (userBookId: string): Promise<StrategyReviewResponse> => {
    const owned = await getOwnedBook(userBookId);
    const draftId = owned.userBook.currentStrategyDraftVersionId;
    if (!draftId) throw new UserBookError('当前处理方式不存在', 409);
    const [draft] = await db.select().from(strategyDraftVersions).where(eq(strategyDraftVersions.id, draftId)).limit(1);
    if (!draft || draft.userBookId !== userBookId) throw new UserBookError('当前处理方式不存在', 404);
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
      adjustmentCount: owned.userBook.adjustmentCount,
      adjustmentLimit: ADJUSTMENT_LIMIT,
      canAdjust: owned.userBook.adjustmentCount < ADJUSTMENT_LIMIT,
    };
  };

  // Fast-path idempotency (§6.5): a replay with a key we already recorded returns the current
  // strategy without re-running the LLM. Backed by the indexed `idempotencyKey` column (was a
  // jsonb payload full-scan); the partial unique index is the race-safe backstop for the rare
  // concurrent duplicate (see isFeedbackIdempotencyConflict).
  const feedbackAlreadyApplied = async (userBookId: string, idempotencyKey: string) => {
    const owned = await getOwnedBook(userBookId);
    if (!owned.userBook.currentInterviewSessionId) return false;
    const [message] = await db
      .select({ id: interviewMessages.id })
      .from(interviewMessages)
      .where(and(
        eq(interviewMessages.interviewSessionId, owned.userBook.currentInterviewSessionId),
        eq(interviewMessages.kind, 'feedback'),
        eq(interviewMessages.idempotencyKey, idempotencyKey),
      ))
      .limit(1);
    return Boolean(message);
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
    },
  ): Promise<StrategyReviewResponse> => {
    const setup = await getSetupContext(userBookId);
    const outcome = await options.setupEngine.runTurn({
      sessionId: setup.owned.userBook.currentInterviewSessionId!,
      phase: 'strategy_review',
      askedCount: 0,
      context: { ...setup.context, currentStrategy: params.draft },
      feedback: params.feedback,
    });
    if (outcome.type !== 'revised') throw new UserBookError('处理方式修订失败', 503);
    const revised = outcome;
    try {
      await db.transaction(async (tx) => {
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
          await tx
            .update(nodeGenerations)
            .set({ status: 'superseded', result: null, completedAt: new Date(), updatedAt: new Date() })
            .where(and(
              eq(nodeGenerations.userBookId, userBookId),
              eq(nodeGenerations.generationScope, 'trial'),
              inArray(nodeGenerations.status, ['queued', 'generating', 'retrying', 'ready', 'failed']),
            ));
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
      });
    } catch (error) {
      if (isFeedbackIdempotencyConflict(error)) return strategyState(userBookId);
      throw error;
    }
    return strategyState(userBookId);
  };

  const getManifestAndHtml = async (sharedBookId: string) => {
    const [manifestValue, content] = await Promise.all([
      options.books.getManifest(sharedBookId),
      options.books.getContent(sharedBookId),
    ]);
    if (!manifestValue || !content) throw new UserBookError('书籍原文或阅读索引不存在', 409);
    return { manifest: asManifest(manifestValue), html: new TextDecoder().decode(content) };
  };

  const createTrialRevision = async (
    userBookId: string,
    draftId: string,
    approveDraft = false,
    fragments?: TrialCandidate[],
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
      return { candidate, node, ordinal: index + 1, range: candidate.range };
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
          inArray(userBooks.workflowStatus, ['strategy_review', 'trial_generation_failed']),
        ))
        .returning({ id: userBooks.id });
      if (advanced.length !== 1) throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
      return { revision, generationIds };
    });
    try {
      await Promise.all(created.generationIds.map((generationId) => options.generations.enqueue({ generationId, userBookId, scope: 'trial' })));
    } catch (error) {
      await db.transaction(async (tx) => {
        await tx.update(nodeGenerations).set({
          status: 'failed',
          errorSummary: '内容生成任务入队失败',
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(inArray(nodeGenerations.id, created.generationIds));
        await tx.update(trialSegments).set({ status: 'failed', updatedAt: new Date() }).where(eq(trialSegments.trialRevisionId, created.revision.id));
        await tx.update(trialRevisions).set({
          status: 'failed',
          failureSummary: '试读内容暂时无法开始生成，请重试。',
          failedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(trialRevisions.id, created.revision.id));
        // §6.5 guard: only fail the book we just moved to trial_generating for this revision.
        await tx.update(userBooks).set({ workflowStatus: 'trial_generation_failed', updatedAt: new Date() }).where(and(
          eq(userBooks.id, userBookId),
          eq(userBooks.workflowStatus, 'trial_generating'),
          eq(userBooks.currentTrialRevisionId, created.revision.id),
        ));
      });
      throw new UserBookError(
        error instanceof Error ? `试读任务入队失败：${error.message}` : '试读任务入队失败',
        503,
      );
    }
    return created.revision;
  };

  // §3.5: after approval, run one agent turn that reads the candidate node bodies and
  // returns exactly three block-range fragments (threshold / typical / hardest). The host
  // pre-extracts the candidate nodes' blocks into the turn context so the agent picks real
  // ranges in a single turn; the returned fragments are validated by createTrialRevision.
  const selectTrialFragments = async (
    userBookId: string,
    draft: StrategyReviewResponse['draft'],
  ): Promise<TrialCandidate[]> => {
    const setup = await getSetupContext(userBookId);
    const { manifest, html } = await getManifestAndHtml(setup.owned.sharedBook.id);
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
    const outcome = await options.setupEngine.runTurn({
      sessionId: setup.owned.userBook.currentInterviewSessionId!,
      phase: 'select_trial',
      askedCount: 0,
      context: { ...setup.context, currentStrategy: draft, trialNodeContents },
    });
    if (outcome.type !== 'fragments') throw new UserBookError('试读片段选择失败', 503);
    return mapFragments(outcome.fragments);
  };

  const trialState = async (userBookId: string): Promise<TrialReviewResponse> => {
    const owned = await getOwnedBook(userBookId);
    const revisionId = owned.userBook.currentTrialRevisionId;
    if (!revisionId) throw new UserBookError('当前试读不存在', 409);
    const [revision, segmentRows, source] = await Promise.all([
      db.select().from(trialRevisions).where(eq(trialRevisions.id, revisionId)).limit(1).then((rows) => rows[0]),
      db
        .select({ segment: trialSegments, generation: nodeGenerations })
        .from(trialSegments)
        .leftJoin(nodeGenerations, eq(nodeGenerations.trialSegmentId, trialSegments.id))
        .where(eq(trialSegments.trialRevisionId, revisionId))
        .orderBy(asc(trialSegments.ordinal)),
      getManifestAndHtml(owned.sharedBook.id),
    ]);
    if (!revision) throw new UserBookError('当前试读不存在', 404);
    // §6.3 / §10.5: all-or-nothing is a server-side guarantee, not just the client-side
    // `canAdopt` gate. Until the whole revision is published we withhold every per-segment
    // `result`, so `workflow()` during `trial_generating` and a `failed`/`superseded` round
    // never leak a partially-generated fragment.
    const exposeResults = revision.status === 'published';
    const segments = segmentRows.map(({ segment, generation }) => {
      const extracted = extractNodeSourceFromHtml(source.html, segment.sectionId, segment.segment);
      const range = {
        start: { block_index: segment.startBlockIndex, offset: segment.startOffset },
        end: { block_index: segment.endBlockIndex, offset: segment.endOffset },
      };
      const sliced = sliceNodeSource(extracted, range);
      const node = source.manifest.nodes.find((item) => item.section_id === segment.sectionId && item.segment === segment.segment)!;
      return {
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
        status: segment.status,
        result: exposeResults ? generation?.result ?? null : null,
        viewedAt: segment.viewedAt?.toISOString() ?? null,
      };
    });
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
      canAdjust: owned.userBook.adjustmentCount < ADJUSTMENT_LIMIT,
      // Adoption only requires the three fragments to be generated and published — the reader
      // is not forced to open all three first (the prototype has no such gate).
      canAdopt: revision.status === 'published' && segments.length === 3 && segments.every((segment) => segment.status === 'ready'),
    };
  };

  const enqueuePendingFormalGenerations = async (userBookId: string) => {
    const pending = await db
      .select({ id: nodeGenerations.id })
      .from(nodeGenerations)
      .where(and(
        eq(nodeGenerations.userBookId, userBookId),
        eq(nodeGenerations.generationScope, 'formal'),
        inArray(nodeGenerations.status, ['queued', 'retrying']),
      ));
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

  const buildReaderBootstrap = async (
    userBookId: string,
    sharedBookId: string,
    strategyVersionId: string,
    strategyDraftVersionId: string,
  ): Promise<ReaderBootstrap> => {
    const [strategy, draft, generations, resume, settings, readRows] = await Promise.all([
      db.select().from(strategyVersions).where(eq(strategyVersions.id, strategyVersionId)).limit(1).then((rows) => rows[0]),
      db.select().from(strategyDraftVersions).where(eq(strategyDraftVersions.id, strategyDraftVersionId)).limit(1).then((rows) => rows[0]),
      db.select().from(nodeGenerations).where(and(eq(nodeGenerations.userBookId, userBookId), eq(nodeGenerations.generationScope, 'formal'))).orderBy(asc(nodeGenerations.createdAt)),
      db.select().from(readerStates).where(eq(readerStates.userBookId, userBookId)).limit(1).then((rows) => rows[0]),
      loadReadingSettings(),
      db.select({ sectionId: readerReadNodes.sectionId, segment: readerReadNodes.segment })
        .from(readerReadNodes)
        .where(eq(readerReadNodes.userBookId, userBookId)),
    ]);
    if (!strategy || !draft) throw new UserBookError('正式处理方式不存在', 409);
    return {
      userBookId,
      sharedBookId,
      workflowStatus: 'active_reading',
      briefing: draft.readingBriefing,
      strategySummary: strategy.userFacingSummary,
      enhancements: generations.map((generation) => ({
        generationId: generation.id,
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
    };
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

    async workflow(userBookId: string): Promise<UserBookWorkflowResponse> {
      const owned = await getOwnedBook(userBookId);
      if (['on_shelf', 'interviewing'].includes(owned.userBook.workflowStatus)) await ensureInterview(userBookId);
      const refreshed = await getOwnedBook(userBookId);
      const status = refreshed.userBook.workflowStatus;
      return {
        workflowStatus: status,
        book: shelfItem(refreshed),
        interview: status === 'interviewing' ? await interviewState(userBookId) : null,
        strategy: status === 'strategy_review' ? await strategyState(userBookId) : null,
        trial: ['trial_generating', 'trial_generation_failed', 'trial_review'].includes(status)
          ? await trialState(userBookId)
          : null,
      };
    },

    interviewState,

    // Streaming answer endpoint (§4). Commits the answer, then runs the interviewing turn,
    // yielding token-level deltas as the model streams the next question — or `concluding`
    // then `done` when it finishes the interview. Validation errors are thrown before the
    // first yield so the route can still surface them as HTTP status codes; failures after the
    // stream opens become an in-band `error` event.
    async *streamInterviewAnswer(
      userBookId: string,
      input: SubmitInterviewAnswerRequest,
    ): AsyncGenerator<InterviewStreamEvent> {
      const { inserted, sessionId } = await commitInterviewAnswer(userBookId, input);
      if (inserted) {
        const [session] = await db.select().from(interviewSessions).where(eq(interviewSessions.id, sessionId)).limit(1);
        if (session && session.status === 'active') {
          const bridge = createStreamBridge<InterviewStreamEvent>();
          let turnError: unknown;
          const running = generateNextQuestion(userBookId, sessionId, session, (delta) => bridge.push(delta))
            .catch((error: unknown) => {
              turnError = error;
            })
            .finally(() => bridge.end());
          for await (const delta of bridge.drain()) yield delta;
          await running;
          if (turnError) {
            yield {
              type: 'error',
              message: turnError instanceof UserBookError ? turnError.message : '生成下一步时出错，请稍后重试。',
            };
            return;
          }
        }
      }
      yield* terminalInterviewEvents(userBookId);
    },

    strategyState,

    async submitStrategyFeedback(userBookId: string, input: SubmitStrategyFeedbackRequest) {
      if (await feedbackAlreadyApplied(userBookId, input.idempotencyKey)) {
        return strategyState(userBookId);
      }
      const owned = await getOwnedBook(userBookId);
      if (owned.userBook.workflowStatus !== 'strategy_review') {
        throw new UserBookError('当前阶段不能修改处理方式', 409);
      }
      const current = await strategyState(userBookId);
      if (!current.canAdjust) throw new UserBookError('已经达到 5 次调整上限', 409);
      if (current.draft.id !== input.strategyDraftVersionId) throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
      if (
        current.draft.status !== 'draft'
        && !(current.draft.status === 'approved_for_trial' && !owned.userBook.currentTrialRevisionId)
      ) {
        throw new UserBookError('当前处理方式已经进入试读，不能从旧页面直接修改', 409);
      }
      return reviseFromFeedback(userBookId, {
        draft: current.draft,
        feedback: input.feedback,
        idempotencyKey: input.idempotencyKey,
      });
    },

    async approveStrategy(userBookId: string, input: ApproveStrategyRequest): Promise<ApproveStrategyResponse> {
      const current = await strategyState(userBookId);
      const owned = await getOwnedBook(userBookId);
      if (
        current.draft.id === input.strategyDraftVersionId
        && current.draft.status === 'approved_for_trial'
        && owned.userBook.currentTrialRevisionId
        && ['trial_generating', 'trial_generation_failed', 'trial_review'].includes(owned.userBook.workflowStatus)
      ) {
        return {
          userBookId,
          workflowStatus: owned.userBook.workflowStatus,
          strategyDraftVersionId: current.draft.id,
          trialRevisionId: owned.userBook.currentTrialRevisionId,
        };
      }
      if (current.draft.id !== input.strategyDraftVersionId || current.draft.status !== 'draft') {
        throw new UserBookError('处理方式已经确认或更新', 409);
      }
      const fragments = await selectTrialFragments(userBookId, current.draft);
      const revision = await createTrialRevision(userBookId, current.draft.id, true, fragments);
      return { userBookId, workflowStatus: 'trial_generating', strategyDraftVersionId: current.draft.id, trialRevisionId: revision.id };
    },

    trialState,

    async retryTrial(userBookId: string) {
      const current = await trialState(userBookId);
      if (current.status !== 'failed') throw new UserBookError('当前试读不需要重试', 409);
      await db.transaction(async (tx) => {
        const changed = await tx
          .update(trialRevisions)
          .set({ status: 'superseded', supersededAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(trialRevisions.id, current.trialRevisionId),
            eq(trialRevisions.userBookId, userBookId),
            eq(trialRevisions.status, 'failed'),
          ))
          .returning({ id: trialRevisions.id });
        if (changed.length !== 1) throw new UserBookError('试读状态已经更新', 409);
        const [book] = await tx.select().from(userBooks).where(eq(userBooks.id, userBookId)).limit(1);
        if (
          !book
          || book.workflowStatus !== 'trial_generation_failed'
          || book.currentTrialRevisionId !== current.trialRevisionId
        ) {
          throw new UserBookError('试读状态已经更新', 409);
        }
        await tx.update(nodeGenerations).set({ status: 'superseded', result: null, completedAt: new Date(), updatedAt: new Date() }).where(and(
          eq(nodeGenerations.userBookId, userBookId),
          eq(nodeGenerations.generationScope, 'trial'),
          inArray(nodeGenerations.status, ['queued', 'generating', 'retrying', 'ready', 'failed']),
        ));
      });
      await createTrialRevision(userBookId, current.strategyDraftVersionId);
      return trialState(userBookId);
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
      if (await feedbackAlreadyApplied(userBookId, input.idempotencyKey)) {
        return strategyState(userBookId);
      }
      const current = await trialState(userBookId);
      if (!current.canAdjust) throw new UserBookError('已经达到 5 次调整上限', 409);
      if (current.trialRevisionId !== input.trialRevisionId) throw new UserBookError('试读版本已经更新', 409);
      // §6.4: void the published trial round AND produce the revised draft in ONE recoverable
      // transaction (reviseFromFeedback), replacing the previous two-commit split that could
      // strand the book in strategy_review with the trial voided but no new draft and no count
      // bump — after which a retry hit `当前试读不存在` (currentTrialRevisionId already null).
      const { draft } = await strategyState(userBookId);
      return reviseFromFeedback(userBookId, {
        draft,
        feedback: input.feedback,
        idempotencyKey: input.idempotencyKey,
        trialRevisionId: input.trialRevisionId,
      });
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
        .values({ userBookId, sectionId: input.sectionId, segment: input.segment })
        .onConflictDoNothing();
      const rows = await db
        .select({ sectionId: readerReadNodes.sectionId, segment: readerReadNodes.segment })
        .from(readerReadNodes)
        .where(eq(readerReadNodes.userBookId, userBookId));
      return { readNodes: rows.map((row) => ({ sectionId: row.sectionId, segment: row.segment })) };
    },
  };
}

export type UserBookService = ReturnType<typeof createUserBookService>;
export type UserBookUserService = ReturnType<typeof createUserBookServiceForUser>;
