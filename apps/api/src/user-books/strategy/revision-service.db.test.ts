import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Strategy, StrategyReviewResponse } from '@readtailor/contracts';
import type { ReadingSetupOutcome, ReadingStrategy } from '@readtailor/agent-kit';
import {
  interviewMessages,
  nodeGenerations,
  readingSetupOperations,
  sharedBooks,
  strategyDraftVersions,
  trialRevisions,
  userBooks,
} from '@readtailor/database';
import type { BookService } from '../../books';
import type { ReadingSetupEngine } from '../../reading-setup-engine';
import {
  getTestDatabase,
  hasTestDatabase,
  strategyReviewGraph,
  trialReviewGraph,
} from '../../test/database';
import type { OwnedUserBook } from '../context/setup-context';
import { UserBookError } from '../errors';
import { createSetupOperationStore } from '../operations/setup-operation-store';
import { createStrategyRevisionService } from './revision-service';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

const revisedOutcome: ReadingSetupOutcome = {
  type: 'revised',
  publicStrategy: '修订后的处理方式',
  strategy: {
    goals: ['理解修订后的核心概念'],
    expression_principles: ['保持简洁'],
    guide: { enabled: true, objectives: ['建立阅读方向'] },
    annotations: { enabled: true, focuses: ['关键术语'], exclusions: [] },
    after_reading: { enabled: true, objectives: ['回顾要点'] },
    trial_candidates: [1, 2, 3].map((ordinal) => ({
      section_id: `section-${ordinal}`,
      segment: 1,
      reason: `修订候选 ${ordinal}`,
    })),
  },
};

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

function fakeBooks(): BookService {
  return {
    async listBooks() { return []; },
    async canAccess() { return false; },
    async getNormalizationStatus() { return null; },
    async getBook() { return null; },
    async getManifest() { return {}; },
    async getProfile() { return {}; },
    async getContent() { return null; },
    async getAsset() { return null; },
  };
}

function createHarness(setupEngine: ReadingSetupEngine) {
  const { db } = getTestDatabase();
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
  const operationStore = createSetupOperationStore({ db, getOwnedBook });
  const service = createStrategyRevisionService({
    db,
    books: fakeBooks(),
    setupEngine,
    operationStore,
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
      if (!book || !draft) throw new UserBookError('处理方式版本不存在', 404);
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
  return { db, operationStore, service };
}

function successEngine(
  beforeReturn?: () => Promise<void>,
): ReadingSetupEngine {
  return {
    async runTurn() {
      await beforeReturn?.();
      return revisedOutcome;
    },
  };
}

const failingEngine: ReadingSetupEngine = {
  async runTurn() {
    throw new Error('model unavailable');
  },
};

describePostgres(`strategy revision service${skipReason}`, () => {
  it('keeps strategy business state unchanged when the model fails', async () => {
    const graph = await strategyReviewGraph(getTestDatabase().db);
    const { db, operationStore, service } = createHarness(failingEngine);
    const operation = await service.resolveStrategyFeedback(graph.userBookId, {
      strategyDraftVersionId: graph.strategyDraftVersionId,
      feedback: '请更简洁',
      idempotencyKey: 'strategy-model-failure',
    });

    await expect(service.executeOperation(operation)).rejects.toThrow('model unavailable');
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    const drafts = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId));
    const observed = await operationStore.observeById(graph.userBookId, operation.id);

    expect(book).toMatchObject({
      workflowStatus: 'strategy_review',
      currentStrategyDraftVersionId: graph.strategyDraftVersionId,
      adjustmentCount: 0,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.status).toBe('draft');
    expect(observed?.operation).toMatchObject({ status: 'failed', resultStrategyDraftVersionId: null });
  });

  it('rolls back every domain write when the operation claim becomes stale', async () => {
    const graph = await strategyReviewGraph(getTestDatabase().db);
    let operationId = '';
    const { db, service } = createHarness(successEngine(async () => {
      await db
        .update(readingSetupOperations)
        .set({ leaseId: randomUUID() })
        .where(eq(readingSetupOperations.id, operationId));
    }));
    const operation = await service.resolveStrategyFeedback(graph.userBookId, {
      strategyDraftVersionId: graph.strategyDraftVersionId,
      feedback: '测试过期提交',
      idempotencyKey: 'strategy-stale-claim',
    });
    operationId = operation.id;

    await expect(service.executeOperation(operation)).rejects.toMatchObject({
      message: '阅读准备操作已由新请求接管，请查询恢复状态',
      statusCode: 409,
    });
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    const drafts = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId));
    const feedback = await db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.idempotencyKey, 'strategy-stale-claim'));

    expect(book).toMatchObject({
      currentStrategyDraftVersionId: graph.strategyDraftVersionId,
      adjustmentCount: 0,
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.status).toBe('draft');
    expect(feedback).toHaveLength(0);
  });

  it('atomically supersedes the draft, creates its successor and completes the operation', async () => {
    const graph = await strategyReviewGraph(getTestDatabase().db);
    const { db, operationStore, service } = createHarness(successEngine());
    const operation = await service.resolveStrategyFeedback(graph.userBookId, {
      strategyDraftVersionId: graph.strategyDraftVersionId,
      feedback: '请调整说明',
      idempotencyKey: 'strategy-success',
    });

    await service.executeOperation(operation);
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    const drafts = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId))
      .orderBy(asc(strategyDraftVersions.version));
    const observed = await operationStore.observeById(graph.userBookId, operation.id);
    const feedback = await db
      .select()
      .from(interviewMessages)
      .where(eq(interviewMessages.idempotencyKey, 'strategy-success'));

    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.status).toBe('superseded');
    expect(drafts[1]).toMatchObject({ version: 2, status: 'draft', userFacingSummary: '修订后的处理方式' });
    expect(book).toMatchObject({
      workflowStatus: 'strategy_review',
      currentStrategyDraftVersionId: drafts[1]!.id,
      currentTrialRevisionId: null,
      adjustmentCount: 1,
    });
    expect(observed?.operation).toMatchObject({
      status: 'completed',
      resultStrategyDraftVersionId: drafts[1]!.id,
      leaseId: null,
    });
    expect(feedback).toHaveLength(1);
  });

  it('keeps a published trial adoptable when trial feedback generation fails', async () => {
    const graph = await trialReviewGraph(getTestDatabase().db);
    const { db, operationStore, service } = createHarness(failingEngine);
    const operation = await service.resolveTrialFeedback(graph.userBookId, {
      trialRevisionId: graph.trialRevisionId,
      feedback: '重新调整策略',
      idempotencyKey: 'trial-model-failure',
    });

    await expect(service.executeOperation(operation)).rejects.toThrow('model unavailable');
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    const [trial] = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.id, graph.trialRevisionId));
    const generations = await db
      .select()
      .from(nodeGenerations)
      .where(eq(nodeGenerations.userBookId, graph.userBookId));
    const observed = await operationStore.observeById(graph.userBookId, operation.id);

    expect(book).toMatchObject({
      workflowStatus: 'trial_review',
      currentStrategyDraftVersionId: graph.strategyDraftVersionId,
      currentTrialRevisionId: graph.trialRevisionId,
      adjustmentCount: 0,
    });
    expect(trial?.status).toBe('published');
    expect(generations).toHaveLength(3);
    expect(generations.every((generation) => generation.status === 'ready')).toBe(true);
    expect(observed?.operation.status).toBe('failed');
  });
});
