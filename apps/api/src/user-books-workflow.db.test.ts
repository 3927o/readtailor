import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { ReadingSetupOutcome } from '@readtailor/agent-kit';
import {
  bookReaderProfileVersions,
  interviewAnswers,
  interviewSessions,
  nodeGenerations,
  strategyDraftVersions,
  strategyVersions,
  trialRevisions,
  userBooks,
} from '@readtailor/database';
import type { AskAiEngine } from './ask-ai-engine';
import type { BookService } from './books';
import type { ReadingSetupEngine } from './reading-setup-engine';
import { createUserBookService, type ContentGenerationEnqueuer } from './user-books';
import {
  getTestDatabase,
  hasTestDatabase,
  interviewingGraph,
  trialReviewGraph,
} from './test/database';

const nodeContents = [
  '第一节点正文abcdefghij',
  '第二节点正文abcdefghij',
  '第三节点正文abcdefghij',
  '第四节点正文abcdefghij',
];

const manifest = {
  version: 'reading-nodes-1.0',
  nodes: nodeContents.map((content, index) => ({
    section_id: `section-${index + 1}`,
    segment: 1,
    order: index + 1,
    title: `第 ${index + 1} 节`,
    parent_section_id: null,
    tailoring_eligible: true,
    blocks: [{ block_index: 1, block_utf16_length: content.length }],
  })),
  outline: nodeContents.map((_content, index) => ({
    section_id: `section-${index + 1}`,
    title: `第 ${index + 1} 节`,
    parent_section_id: null,
  })),
};

const normalizedHtml = `<!doctype html><html><body><main id="book" data-type="book">
  ${nodeContents.map((content, index) => (
    `<section id="section-${index + 1}" data-type="section"><h2>第 ${index + 1} 节</h2><p>${content}</p></section>`
  )).join('\n  ')}
</main></body></html>`;

const bookProfile = {
  summary: '测试书籍围绕四个连续主题展开。',
  structure: '四个节点按顺序推进。',
  trial_candidates: manifest.nodes.slice(0, 3).map((node) => ({
    section_id: node.section_id,
    segment: node.segment,
  })),
};

const completedOutcome: ReadingSetupOutcome = {
  type: 'completed',
  bookReaderProfile: {
    summary: '读者希望建立可靠的整体理解。',
    motivations: ['完成阅读并掌握主线'],
    prior_knowledge: ['具备基础背景'],
    reading_goals: ['理解并应用关键概念'],
    likely_barriers: ['容易失去章节之间的联系'],
  },
  briefing: {
    book_identity: '一本用于验证阅读准备事务的测试书籍。',
    arc: '四个节点依次推进。',
    assumed_knowledge: '只要求基础背景。',
    reading_advice: '先抓主线，再看细节。',
  },
  publicStrategy: '以简短导读建立方向，只在关键处增加解释。',
  strategy: {
    goals: ['掌握全书主线'],
    expression_principles: ['保持简洁并尊重原文'],
    guide: { enabled: true, objectives: ['说明当前位置'] },
    annotations: { enabled: true, focuses: ['关键概念'], exclusions: [] },
    after_reading: { enabled: true, objectives: ['回顾节点要点'] },
    trial_candidates: manifest.nodes.slice(0, 3).map((node, index) => ({
      section_id: node.section_id,
      segment: node.segment,
      reason: `验证候选节点 ${index + 1}`,
    })),
  },
};

const books: BookService = {
  async listBooks() {
    return [];
  },
  async canAccess() {
    return true;
  },
  async getNormalizationStatus() {
    return null;
  },
  async getBook() {
    return null;
  },
  async getManifest() {
    return manifest;
  },
  async getProfile() {
    return bookProfile;
  },
  async getContent() {
    return new TextEncoder().encode(normalizedHtml);
  },
  async getAsset() {
    return null;
  },
};

const askAiEngine: AskAiEngine = {
  async runTurn() {
    throw new Error('ask AI is outside this test scope');
  },
};

function createService(
  setupEngine: ReadingSetupEngine,
  generations: ContentGenerationEnqueuer = { async enqueue() {} },
) {
  const { db } = getTestDatabase();
  return createUserBookService({
    db,
    books,
    setupEngine,
    askAiEngine,
    generations,
    modelConfigId: 'database-test-model',
  });
}

async function collect<T>(stream: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

describePostgres(`user book workflow PostgreSQL integration${skipReason}`, () => {
  it('atomically advances the final interview answer to a profile and strategy draft', async () => {
    const { db } = getTestDatabase();
    const graph = await interviewingGraph(db);
    const runTurn = vi.fn<ReadingSetupEngine['runTurn']>(async () => completedOutcome);
    const service = createService({ runTurn }).forUser(graph.userId);

    const events = await collect(service.streamInterviewAnswer(graph.userBookId, {
      questionId: 'purpose',
      selectedOptionIds: ['overview'],
      freeText: null,
      idempotencyKey: randomUUID(),
    }));

    const [session] = await db
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, graph.interviewSessionId));
    const profiles = await db
      .select()
      .from(bookReaderProfileVersions)
      .where(eq(bookReaderProfileVersions.userBookId, graph.userBookId));
    const drafts = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId));
    const [userBook] = await db
      .select()
      .from(userBooks)
      .where(eq(userBooks.id, graph.userBookId));

    expect(runTurn).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({ type: 'done', workflowStatus: 'strategy_review' });
    expect(session).toMatchObject({
      status: 'completed',
      conversationVersion: 2,
      turnLeaseId: null,
      turnLeaseVersion: null,
    });
    expect(session?.completedAt).toBeInstanceOf(Date);
    expect(profiles).toHaveLength(1);
    expect(drafts).toHaveLength(1);
    expect(userBook).toMatchObject({
      workflowStatus: 'strategy_review',
      currentInterviewSessionId: graph.interviewSessionId,
      currentBookReaderProfileVersionId: profiles[0]?.id,
      currentStrategyDraftVersionId: drafts[0]?.id,
    });
  });

  it('keeps an agent failure recoverable without creating partial strategy state', async () => {
    const { db } = getTestDatabase();
    const graph = await interviewingGraph(db);
    let failNextTurn = true;
    const runTurn = vi.fn<ReadingSetupEngine['runTurn']>(async () => {
      if (failNextTurn) {
        failNextTurn = false;
        throw new Error('model unavailable');
      }
      return completedOutcome;
    });
    const service = createService({ runTurn }).forUser(graph.userId);

    const events = await collect(service.streamInterviewAnswer(graph.userBookId, {
      questionId: 'purpose',
      selectedOptionIds: ['apply'],
      freeText: null,
      idempotencyKey: randomUUID(),
    }));

    const [failedSession] = await db
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, graph.interviewSessionId));
    const answers = await db
      .select()
      .from(interviewAnswers)
      .where(eq(interviewAnswers.interviewSessionId, graph.interviewSessionId));
    const failedProfiles = await db
      .select()
      .from(bookReaderProfileVersions)
      .where(eq(bookReaderProfileVersions.userBookId, graph.userBookId));
    const failedDrafts = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId));
    const [failedBook] = await db
      .select()
      .from(userBooks)
      .where(eq(userBooks.id, graph.userBookId));

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'agent_failed' });
    expect(answers).toHaveLength(1);
    expect(failedSession).toMatchObject({
      status: 'active',
      questionCount: 1,
      conversationVersion: 2,
      turnLeaseId: null,
      turnLeaseVersion: null,
    });
    expect(failedProfiles).toHaveLength(0);
    expect(failedDrafts).toHaveLength(0);
    expect(failedBook).toMatchObject({
      workflowStatus: 'interviewing',
      currentBookReaderProfileVersionId: null,
      currentStrategyDraftVersionId: null,
    });

    const recovered = await service.resumeInterview(graph.userBookId);
    const [recoveredBook] = await db
      .select()
      .from(userBooks)
      .where(eq(userBooks.id, graph.userBookId));
    expect(recovered.status).toBe('completed');
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(recoveredBook?.workflowStatus).toBe('strategy_review');
  });

  it('adopts a published trial idempotently under concurrent requests', async () => {
    const { db } = getTestDatabase();
    const graph = await trialReviewGraph(db);
    const enqueuedGenerationIds: string[] = [];
    const generations: ContentGenerationEnqueuer = {
      async enqueue(input) {
        enqueuedGenerationIds.push(input.generationId);
      },
    };
    const setupEngine: ReadingSetupEngine = {
      async runTurn() {
        throw new Error('reading setup agent is not used during adoption');
      },
    };
    const service = createService(setupEngine, generations).forUser(graph.userId);
    const input = {
      trialRevisionId: graph.trialRevisionId,
      strategyDraftVersionId: graph.strategyDraftVersionId,
    };

    const [first, second] = await Promise.all([
      service.adoptTrial(graph.userBookId, input),
      service.adoptTrial(graph.userBookId, input),
    ]);
    const replay = await service.adoptTrial(graph.userBookId, input);

    const formalStrategies = await db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.userBookId, graph.userBookId));
    const formalGenerations = await db
      .select()
      .from(nodeGenerations)
      .where(eq(nodeGenerations.generationScope, 'formal'));
    const [draft] = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.id, graph.strategyDraftVersionId));
    const [revision] = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.id, graph.trialRevisionId));
    const [userBook] = await db
      .select()
      .from(userBooks)
      .where(eq(userBooks.id, graph.userBookId));

    expect(first.strategyVersionId).toBe(second.strategyVersionId);
    expect(replay.strategyVersionId).toBe(first.strategyVersionId);
    expect(formalStrategies).toHaveLength(1);
    expect(formalGenerations).toHaveLength(4);
    expect(new Set(formalGenerations.map((generation) => (
      `${generation.sectionId}:${generation.segment}`
    ))).size).toBe(4);
    expect(new Set(enqueuedGenerationIds)).toEqual(
      new Set(formalGenerations.map(({ id }) => id)),
    );
    expect(draft).toMatchObject({ status: 'confirmed' });
    expect(revision).toMatchObject({ status: 'adopted' });
    expect(userBook).toMatchObject({
      workflowStatus: 'active_reading',
      currentStrategyVersionId: first.strategyVersionId,
    });
  });
});
