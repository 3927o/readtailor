import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { ReaderProfile, Strategy } from '@readtailor/contracts';
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

function createService() {
  const { db } = getTestDatabase();
  const books = {
    async listBooks() { return []; },
    async canAccess() { return false; },
    async getNormalizationStatus() { return null; },
    async getBook() { return null; },
    async getManifest() { return null; },
    async getProfile() { return null; },
    async getContent() { return null; },
    async getAsset() { return null; },
  } satisfies BookService;
  const setupEngine = {
    async runTurn() { throw new Error('not used'); },
  } as ReadingSetupEngine;
  const getOwnedBook = async (userBookId: string): Promise<OwnedUserBook> => {
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
    async getSetupContext() { throw new Error('not used'); },
    createReadingNodeProjector() { throw new Error('not used'); },
    mapStrategy,
    applyReaderProfilePatch(profile: ReaderProfile, _patch: ReaderProfilePatch) {
      return profile;
    },
    async loadStrategyState() { throw new Error('not used'); },
  });
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
