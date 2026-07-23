import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { ReaderProfile, Strategy, StrategyReviewResponse } from '@readtailor/contracts';
import type { ReaderProfilePatch, ReadingStrategy } from '@readtailor/agent-kit';
import {
  bookReaderProfileVersions,
  interviewAnswers,
  interviewMessages,
  interviewSessions,
  sharedBooks,
  strategyDraftVersions,
  userBooks,
} from '@readtailor/database';
import type { BookService } from '../../books';
import type { ReadingSetupEngine } from '../../reading-setup-engine';
import {
  getTestDatabase,
  hasTestDatabase,
  interviewingGraph,
} from '../../test/database';
import { createReadingManifestFixture } from '../../test/reading-manifest';
import type { OwnedUserBook } from '../context/setup-context';
import { UserBookError } from '../errors';
import { createInterviewService } from './service';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

function mapStrategy(value: ReadingStrategy): Strategy {
  return {
    goals: value.goals,
    expressionPrinciples: value.expression_principles,
    guide: value.guide,
    annotations: value.annotations,
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

function createService(options: {
  setupEngine?: ReadingSetupEngine;
  beforeOwnedRead?(readCount: number): Promise<void>;
} = {}) {
  const { db } = getTestDatabase();
  const books = {
    async listBooks() { return []; },
    async canAccess() { return false; },
    async getNormalizationStatus() { return null; },
    async getBook() { return null; },
    async getManifest() { return createReadingManifestFixture([]); },
    async getProfile() { return null; },
    async getContent() { return null; },
    async getAsset() { return null; },
  } satisfies BookService;
  const setupEngine = options.setupEngine ?? {
    async runTurn() { throw new Error('not used'); },
  } satisfies ReadingSetupEngine;
  let ownedReadCount = 0;
  const getOwnedBook = async (userBookId: string): Promise<OwnedUserBook> => {
    ownedReadCount += 1;
    await options.beforeOwnedRead?.(ownedReadCount);
    const [owned] = await db
      .select({ userBook: userBooks, sharedBook: sharedBooks })
      .from(userBooks)
      .innerJoin(sharedBooks, eq(sharedBooks.id, userBooks.sharedBookId))
      .where(eq(userBooks.id, userBookId))
      .limit(1);
    if (!owned) throw new UserBookError('用户书籍不存在', 404);
    return owned;
  };
  return createInterviewService({
    db,
    books,
    setupEngine,
    getOwnedBook,
    async getSetupContext(userBookId) {
      return {
        owned: await getOwnedBook(userBookId),
        context: { bookProfile: {} },
      };
    },
    createReadingNodeProjector() {
      return (candidate) => ({
        ordinal: candidate.ordinal,
        sectionId: candidate.sectionId,
        segment: candidate.segment,
        chapterPath: [`Section ${candidate.ordinal}`],
        reason: candidate.reason,
      });
    },
    mapStrategy,
    applyReaderProfilePatch(profile: ReaderProfile, _patch: ReaderProfilePatch) {
      return profile;
    },
    async loadStrategyState(userBookId, draftId) {
      const [book] = await db
        .select()
        .from(userBooks)
        .where(eq(userBooks.id, userBookId))
        .limit(1);
      const [draft] = await db
        .select()
        .from(strategyDraftVersions)
        .where(eq(strategyDraftVersions.id, draftId))
        .limit(1);
      if (!book || !draft) throw new Error('strategy fixture is incomplete');
      return {
        userBookId,
        workflowStatus: book.workflowStatus,
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
        trialCandidatePreviews: draft.strategy.trialCandidates.map((candidate, index) => ({
          ordinal: index + 1,
          sectionId: candidate.sectionId,
          segment: candidate.segment,
          chapterPath: [`Section ${index + 1}`],
          reason: candidate.reason,
        })),
        adjustmentCount: book.adjustmentCount,
        adjustmentLimit: 5,
        canAdjust: true,
      } as StrategyReviewResponse;
    },
  });
}

async function collect<T>(stream: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const completedOutcome = {
  type: 'completed' as const,
  bookReaderProfile: {
    summary: '用户希望建立全书主线并理解关键概念。',
    motivations: ['完成阅读'],
    prior_knowledge: ['了解基础背景'],
    reading_goals: ['理解核心论点'],
    likely_barriers: ['术语密度较高'],
  },
  briefing: {
    book_identity: '这是一本用于验证访谈事务的测试书籍。',
    arc: '内容从基础概念逐步推进到实际应用。',
    assumed_knowledge: '只需要具备一般背景知识即可开始阅读。',
    reading_advice: '先把握章节主线，再处理局部术语和细节。',
  },
  publicStrategy: '保持原文推进，在关键概念处提供简洁辅助。',
  strategy: {
    goals: ['理解核心概念'],
    expression_principles: ['保持简洁'],
    guide: { enabled: true, objectives: ['建立阅读方向'] },
    annotations: { enabled: true, focuses: ['关键术语'], exclusions: [] },
    after_reading: { enabled: true, objectives: ['回顾要点'] },
    trial_candidates: [1, 2, 3].map((ordinal) => ({
      section_id: `section-${ordinal}`,
      segment: 1,
      reason: `候选片段 ${ordinal}`,
    })),
  },
};

describePostgres(`interview service${skipReason}`, () => {
  it('resumes interview completion from durable checkpoints after a failed turn', async () => {
    const { db } = getTestDatabase();
    const graph = await interviewingGraph(db);
    let turn = 0;
    const runTurn = vi.fn<ReadingSetupEngine['runTurn']>(async (input) => {
      const store = input.completionStore;
      if (!store) throw new Error('completion store is missing');
      let snapshot = await store.load();
      if (!snapshot.completionId) snapshot = await store.start();
      if (!snapshot.briefing) snapshot = await store.submitBriefing(completedOutcome.briefing);
      turn += 1;
      if (turn === 1) throw new Error('provider disconnected after briefing');
      if (!snapshot.strategy) {
        const { trial_candidates: _trialCandidates, ...strategy } = completedOutcome.strategy;
        snapshot = await store.submitStrategy({
          publicStrategy: completedOutcome.publicStrategy,
          strategy,
        });
      }
      if (!snapshot.candidates) {
        snapshot = await store.submitCandidates(completedOutcome.strategy.trial_candidates);
      }
      if (!snapshot.profile) {
        await store.submitProfile({ bookReaderProfile: completedOutcome.bookReaderProfile });
      }
      const artifacts = await store.complete();
      return {
        type: 'completed',
        briefing: artifacts.briefing,
        publicStrategy: artifacts.strategy.publicStrategy,
        strategy: {
          ...artifacts.strategy.strategy,
          trial_candidates: artifacts.candidates,
        },
        bookReaderProfile: artifacts.profile.bookReaderProfile,
        ...(artifacts.profile.readerProfilePatch
          ? { readerProfilePatch: artifacts.profile.readerProfilePatch }
          : {}),
      };
    });
    const service = createService({ setupEngine: { runTurn } });

    const failed = await collect(service.streamAnswer(graph.userBookId, {
      questionId: 'purpose',
      selectedOptionIds: ['overview'],
      freeText: null,
      idempotencyKey: 'checkpoint-resume-answer',
    }));
    expect(failed.at(-1)).toMatchObject({ type: 'error', code: 'agent_failed' });
    expect((await db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewSessionId, graph.interviewSessionId)))
      .filter((message) => message.kind === 'summary')
      .map((message) => message.payload.type)).toEqual([
        'completion_started',
        'briefing_submitted',
      ]);

    const resumed = await collect(service.streamResume(graph.userBookId));
    expect(resumed.map(({ type }) => type)).toEqual(['draft_final', 'done']);
    expect(runTurn).toHaveBeenCalledTimes(2);
    const messages = await db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewSessionId, graph.interviewSessionId));
    expect(messages.filter((message) => message.kind === 'summary').map((message) => message.payload.type))
      .toEqual([
        'completion_started',
        'briefing_submitted',
        'strategy_submitted',
        'trial_candidates_submitted',
        'interview_profile_submitted',
      ]);
    expect(await db
      .select()
      .from(bookReaderProfileVersions)
      .where(eq(bookReaderProfileVersions.userBookId, graph.userBookId))).toHaveLength(1);
    expect(await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId))).toHaveLength(1);
  });

  it('replays an answer key through streamAnswer without running the agent twice', async () => {
    const { db } = getTestDatabase();
    const graph = await interviewingGraph(db);
    let releaseAgent!: () => void;
    const agentGate = new Promise<void>((resolve) => {
      releaseAgent = resolve;
    });
    const runTurn = vi.fn<ReadingSetupEngine['runTurn']>(async () => {
      await agentGate;
      return completedOutcome;
    });
    const service = createService({
      setupEngine: { runTurn },
      async beforeOwnedRead(readCount) {
        if (readCount !== 4) return;
        releaseAgent();
        await vi.waitFor(async () => {
          const [book] = await db
            .select({ workflowStatus: userBooks.workflowStatus })
            .from(userBooks)
            .where(eq(userBooks.id, graph.userBookId));
          expect(book?.workflowStatus).toBe('strategy_review');
        }, { timeout: 30_000, interval: 100 });
      },
    });
    const input = {
      questionId: 'purpose',
      selectedOptionIds: ['overview'],
      freeText: null,
      idempotencyKey: 'answer-stream-replay',
    };

    const first = collect(service.streamAnswer(graph.userBookId, input));
    await vi.waitFor(
      () => expect(runTurn).toHaveBeenCalledOnce(),
      { timeout: 30_000, interval: 100 },
    );
    const replay = collect(service.streamAnswer(graph.userBookId, input));
    const [firstEvents, replayEvents] = await Promise.all([first, replay]);

    const answers = await db
      .select()
      .from(interviewAnswers)
      .where(eq(interviewAnswers.interviewSessionId, graph.interviewSessionId));
    const profiles = await db
      .select()
      .from(bookReaderProfileVersions)
      .where(eq(bookReaderProfileVersions.userBookId, graph.userBookId));
    const drafts = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId));

    expect(runTurn).toHaveBeenCalledOnce();
    expect(firstEvents.map(({ type }) => type)).toEqual(['draft_final', 'done']);
    expect(replayEvents).toMatchObject([{ type: 'done', workflowStatus: 'strategy_review' }]);
    expect(answers).toHaveLength(1);
    expect(profiles).toHaveLength(1);
    expect(drafts).toHaveLength(1);
  });

  it('commits an answer idempotently and completes the final turn atomically', async () => {
    const { db } = getTestDatabase();
    const graph = await interviewingGraph(db);
    const service = createService();
    const input = {
      questionId: 'purpose',
      selectedOptionIds: ['overview'],
      freeText: '并形成笔记',
      idempotencyKey: 'answer-1',
    };

    const committed = await service.commitAnswer(graph.userBookId, input);
    expect(committed.inserted).toBe(true);
    expect(committed.claim).toMatchObject({
      sessionId: graph.interviewSessionId,
      questionCount: 1,
      conversationVersion: 2,
    });
    expect(await service.commitAnswer(graph.userBookId, input)).toEqual({
      inserted: false,
      sessionId: graph.interviewSessionId,
    });

    const saved = await service.saveSetupOutcome(
      graph.userBookId,
      completedOutcome,
      committed.claim!,
    );
    expect(saved.committed).toBe(true);
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    const [session] = await db
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, graph.interviewSessionId));
    const answers = await db
      .select()
      .from(interviewAnswers)
      .where(eq(interviewAnswers.interviewSessionId, graph.interviewSessionId));
    const messages = await db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.interviewSessionId, graph.interviewSessionId));
    const profiles = await db
      .select()
      .from(bookReaderProfileVersions)
      .where(eq(bookReaderProfileVersions.userBookId, graph.userBookId));
    const drafts = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId));

    expect(book).toMatchObject({
      workflowStatus: 'strategy_review',
      currentBookReaderProfileVersionId: profiles[0]!.id,
      currentStrategyDraftVersionId: drafts[0]!.id,
    });
    expect(session).toMatchObject({ status: 'completed', turnLeaseId: null });
    expect(answers).toHaveLength(1);
    expect(messages).toHaveLength(2);
    expect(profiles).toHaveLength(1);
    expect(drafts).toHaveLength(1);
  });

  it('lets an expired turn lease be reclaimed and fences the old owner', async () => {
    const { db } = getTestDatabase();
    const graph = await interviewingGraph(db);
    const service = createService();
    const committed = await service.commitAnswer(graph.userBookId, {
      questionId: 'purpose',
      selectedOptionIds: ['overview'],
      freeText: null,
      idempotencyKey: 'answer-expired-lease',
    });
    const oldClaim = committed.claim!;
    await db
      .update(interviewSessions)
      .set({
        turnLeaseClaimedAt: sql`now() - interval '2 minutes'`,
        turnLeaseExpiresAt: sql`now() - interval '1 minute'`,
      })
      .where(eq(interviewSessions.id, graph.interviewSessionId));

    const newClaim = await service.claimTurn(graph.interviewSessionId);

    expect(newClaim).not.toBeNull();
    expect(newClaim?.leaseId).not.toBe(oldClaim.leaseId);
    expect(newClaim).toMatchObject({
      sessionId: oldClaim.sessionId,
      questionCount: oldClaim.questionCount,
      conversationVersion: oldClaim.conversationVersion,
    });
    expect(await service.renewTurn(oldClaim)).toBe(false);
    expect(await service.saveSetupOutcome(
      graph.userBookId,
      completedOutcome,
      oldClaim,
    )).toEqual({ committed: false });
    expect(await db
      .select()
      .from(bookReaderProfileVersions)
      .where(eq(bookReaderProfileVersions.userBookId, graph.userBookId))).toHaveLength(0);
    expect(await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId))).toHaveLength(0);

    expect(await service.saveSetupOutcome(
      graph.userBookId,
      completedOutcome,
      newClaim!,
    )).toMatchObject({ committed: true });
    expect(await db
      .select()
      .from(bookReaderProfileVersions)
      .where(eq(bookReaderProfileVersions.userBookId, graph.userBookId))).toHaveLength(1);
    expect(await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId))).toHaveLength(1);
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    expect(book?.workflowStatus).toBe('strategy_review');
  });

  it('rejects a stale finalizer without creating partial setup records', async () => {
    const { db } = getTestDatabase();
    const graph = await interviewingGraph(db);
    const service = createService();
    const committed = await service.commitAnswer(graph.userBookId, {
      questionId: 'purpose',
      selectedOptionIds: ['overview'],
      freeText: null,
      idempotencyKey: 'answer-stale',
    });
    await db
      .update(interviewSessions)
      .set({ turnLeaseId: randomUUID() })
      .where(eq(interviewSessions.id, graph.interviewSessionId));

    expect(await service.saveSetupOutcome(
      graph.userBookId,
      completedOutcome,
      committed.claim!,
    )).toEqual({ committed: false });
    expect(await db
      .select()
      .from(bookReaderProfileVersions)
      .where(eq(bookReaderProfileVersions.userBookId, graph.userBookId))).toHaveLength(0);
    expect(await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId))).toHaveLength(0);
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    expect(book?.workflowStatus).toBe('interviewing');
  });
});
