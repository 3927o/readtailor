import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { ReadingSetupOutcome, TrialFragmentSelection } from '@readtailor/agent-kit';
import {
  bookReaderProfileVersions,
  interviewAnswers,
  interviewSessions,
  nodeGenerations,
  readingSetupOperations,
  strategyDraftVersions,
  strategyVersions,
  trialRevisions,
  trialSegments,
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
  strategyReviewGraph,
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

type TrialNodeContent = {
  section_id: string;
  segment: number;
  blocks: Array<{ block_index: number; text: string }>;
};

function validTrialFragments(
  input: Parameters<ReadingSetupEngine['runTurn']>[0],
): TrialFragmentSelection[] {
  const nodes = input.context.trialNodeContents as TrialNodeContent[];
  const tags = ['threshold', 'typical', 'hardest'] as const;
  return nodes.map((node, index) => {
    const firstBlock = node.blocks[0];
    const lastBlock = node.blocks.at(-1);
    if (!firstBlock || !lastBlock || !tags[index]) {
      throw new Error('trial selection test context is incomplete');
    }
    return {
      section_id: node.section_id,
      segment: node.segment,
      tag: tags[index],
      range: {
        start: { block_index: firstBlock.block_index },
        end: { block_index: lastBlock.block_index },
      },
      reason: `验证 ${tags[index]} 试读片段`,
    };
  });
}

const invalidTrialFragmentCases: Array<{
  name: string;
  mutate: (fragments: TrialFragmentSelection[]) => TrialFragmentSelection[];
}> = [
  {
    name: 'a position outside the candidate pool',
    mutate: (fragments) => fragments.map((fragment, index) => (
      index === 0 ? { ...fragment, section_id: 'section-4' } : fragment
    )),
  },
  {
    name: 'a duplicate semantic tag',
    mutate: (fragments) => fragments.map((fragment, index) => (
      index === 1 ? { ...fragment, tag: 'threshold' } : fragment
    )),
  },
  {
    name: 'an out-of-bounds block range',
    mutate: (fragments) => fragments.map((fragment, index) => (
      index === 0
        ? {
            ...fragment,
            range: { start: { block_index: 999 }, end: { block_index: 999 } },
          }
        : fragment
    )),
  },
  {
    name: 'an overlapping selection from the same node',
    mutate: (fragments) => fragments.map((fragment, index) => (
      index === 1
        ? {
            ...fragment,
            section_id: fragments[0]!.section_id,
            segment: fragments[0]!.segment,
            range: fragments[0]!.range,
          }
        : fragment
    )),
  },
];

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

  it('atomically approves a draft and creates one complete trial generation graph', async () => {
    const { db } = getTestDatabase();
    const graph = await strategyReviewGraph(db);
    const runTurn = vi.fn<ReadingSetupEngine['runTurn']>(async (input) => ({
      type: 'fragments',
      fragments: validTrialFragments(input),
    }));
    const enqueue = vi.fn<ContentGenerationEnqueuer['enqueue']>(async () => {});
    const service = createService({ runTurn }, { enqueue }).forUser(graph.userId);
    const idempotencyKey = randomUUID();

    const events = await collect(service.streamApproveStrategy(graph.userBookId, {
      strategyDraftVersionId: graph.strategyDraftVersionId,
      idempotencyKey,
    }));

    const revisions = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.userBookId, graph.userBookId));
    const segments = revisions[0]
      ? await db
          .select()
          .from(trialSegments)
          .where(eq(trialSegments.trialRevisionId, revisions[0].id))
      : [];
    const generations = await db
      .select()
      .from(nodeGenerations)
      .where(eq(nodeGenerations.userBookId, graph.userBookId));
    const [draft] = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.id, graph.strategyDraftVersionId));
    const [book] = await db
      .select()
      .from(userBooks)
      .where(eq(userBooks.id, graph.userBookId));
    const [operation] = await db
      .select()
      .from(readingSetupOperations)
      .where(eq(readingSetupOperations.idempotencyKey, idempotencyKey));

    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn.mock.calls[0]?.[0]).toMatchObject({ phase: 'select_trial' });
    expect(events.at(-1)).toMatchObject({ type: 'trial_created' });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      revision: 1,
      status: 'generating',
      strategyDraftVersionId: graph.strategyDraftVersionId,
    });
    expect(segments).toHaveLength(3);
    expect(segments.map(({ ordinal }) => ordinal).sort()).toEqual([1, 2, 3]);
    expect(new Set(segments.map(({ ordinal }) => ordinal)).size).toBe(3);
    expect(segments.every(({ status }) => status === 'pending')).toBe(true);
    expect(generations).toHaveLength(3);
    expect(generations.every((generation) => (
      generation.generationScope === 'trial'
      && generation.strategyDraftVersionId === graph.strategyDraftVersionId
      && generation.status === 'queued'
    ))).toBe(true);
    expect(new Set(generations.map(({ trialSegmentId }) => trialSegmentId))).toEqual(
      new Set(segments.map(({ id }) => id)),
    );
    expect(new Set(enqueue.mock.calls.map(([input]) => input.generationId))).toEqual(
      new Set(generations.map(({ id }) => id)),
    );
    expect(draft).toMatchObject({ status: 'approved_for_trial' });
    expect(draft?.approvedForTrialAt).toBeInstanceOf(Date);
    expect(book).toMatchObject({
      workflowStatus: 'trial_generating',
      currentStrategyDraftVersionId: graph.strategyDraftVersionId,
      currentTrialRevisionId: revisions[0]?.id,
    });
    expect(operation).toMatchObject({
      kind: 'trial_selection',
      source: 'strategy_approve',
      baseStrategyDraftVersionId: graph.strategyDraftVersionId,
      status: 'completed',
      attemptCount: 1,
      resultTrialRevisionId: revisions[0]?.id,
      leaseId: null,
      errorSummary: null,
    });
    expect(operation?.completedAt).toBeInstanceOf(Date);
  });

  it.each(invalidTrialFragmentCases)(
    'rejects $name without creating partial trial state',
    async ({ mutate }) => {
      const { db } = getTestDatabase();
      const graph = await strategyReviewGraph(db);
      const runTurn = vi.fn<ReadingSetupEngine['runTurn']>(async (input) => ({
        type: 'fragments',
        fragments: mutate(validTrialFragments(input)),
      }));
      const enqueue = vi.fn<ContentGenerationEnqueuer['enqueue']>(async () => {});
      const service = createService({ runTurn }, { enqueue }).forUser(graph.userId);
      const idempotencyKey = randomUUID();

      const events = await collect(service.streamApproveStrategy(graph.userBookId, {
        strategyDraftVersionId: graph.strategyDraftVersionId,
        idempotencyKey,
      }));

      const revisions = await db
        .select()
        .from(trialRevisions)
        .where(eq(trialRevisions.userBookId, graph.userBookId));
      const segments = await db.select().from(trialSegments);
      const generations = await db
        .select()
        .from(nodeGenerations)
        .where(eq(nodeGenerations.userBookId, graph.userBookId));
      const [draft] = await db
        .select()
        .from(strategyDraftVersions)
        .where(eq(strategyDraftVersions.id, graph.strategyDraftVersionId));
      const [book] = await db
        .select()
        .from(userBooks)
        .where(eq(userBooks.id, graph.userBookId));
      const [operation] = await db
        .select()
        .from(readingSetupOperations)
        .where(eq(readingSetupOperations.idempotencyKey, idempotencyKey));

      expect(runTurn).toHaveBeenCalledOnce();
      expect(events.at(-1)).toMatchObject({ type: 'error', code: 'validation_failed' });
      expect(revisions).toHaveLength(0);
      expect(segments).toHaveLength(0);
      expect(generations).toHaveLength(0);
      expect(enqueue).not.toHaveBeenCalled();
      expect(draft).toMatchObject({
        status: 'draft',
        approvedForTrialAt: null,
      });
      expect(book).toMatchObject({
        workflowStatus: 'strategy_review',
        currentStrategyDraftVersionId: graph.strategyDraftVersionId,
        currentTrialRevisionId: null,
      });
      expect(operation).toMatchObject({
        kind: 'trial_selection',
        source: 'strategy_approve',
        baseStrategyDraftVersionId: graph.strategyDraftVersionId,
        status: 'failed',
        attemptCount: 1,
        resultTrialRevisionId: null,
        leaseId: null,
      });
      expect(operation?.errorSummary).toBeTruthy();
      expect(operation?.completedAt).toBeInstanceOf(Date);
    },
  );

  it('commits adoption before enqueue and replays pending generations by state', async () => {
    const { db } = getTestDatabase();
    const graph = await trialReviewGraph(db);
    const failedEnqueueIds: string[] = [];
    const failingGenerations: ContentGenerationEnqueuer = {
      async enqueue(input) {
        failedEnqueueIds.push(input.generationId);
        throw new Error('queue unavailable');
      },
    };
    const setupEngine: ReadingSetupEngine = {
      async runTurn() {
        throw new Error('reading setup agent is not used during adoption');
      },
    };
    const input = {
      trialRevisionId: graph.trialRevisionId,
      strategyDraftVersionId: graph.strategyDraftVersionId,
    };
    expect(input).not.toHaveProperty('idempotencyKey');

    const failingService = createService(setupEngine, failingGenerations).forUser(graph.userId);
    await expect(failingService.adoptTrial(graph.userBookId, input)).rejects.toMatchObject({
      statusCode: 503,
    });

    const committedStrategies = await db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.userBookId, graph.userBookId));
    const committedGenerations = await db
      .select()
      .from(nodeGenerations)
      .where(and(
        eq(nodeGenerations.userBookId, graph.userBookId),
        eq(nodeGenerations.generationScope, 'formal'),
      ));
    const [committedDraft] = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.id, graph.strategyDraftVersionId));
    const [committedRevision] = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.id, graph.trialRevisionId));
    const [committedBook] = await db
      .select()
      .from(userBooks)
      .where(eq(userBooks.id, graph.userBookId));

    expect(committedStrategies).toHaveLength(1);
    expect(committedGenerations).toHaveLength(4);
    expect(new Set(committedGenerations.map((generation) => (
      `${generation.sectionId}:${generation.segment}`
    ))).size).toBe(4);
    expect(committedGenerations.every(({ status }) => status === 'queued')).toBe(true);
    expect(new Set(failedEnqueueIds)).toEqual(
      new Set(committedGenerations.map(({ id }) => id)),
    );
    expect(committedDraft).toMatchObject({ status: 'confirmed' });
    expect(committedRevision).toMatchObject({ status: 'adopted' });
    expect(committedBook).toMatchObject({
      workflowStatus: 'active_reading',
      currentStrategyVersionId: committedStrategies[0]?.id,
    });

    const replayEnqueueIds: string[] = [];
    const replayService = createService(setupEngine, {
      async enqueue(enqueueInput) {
        replayEnqueueIds.push(enqueueInput.generationId);
      },
    }).forUser(graph.userId);
    const replay = await replayService.adoptTrial(graph.userBookId, input);

    const replayedStrategies = await db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.userBookId, graph.userBookId));
    const replayedGenerations = await db
      .select()
      .from(nodeGenerations)
      .where(and(
        eq(nodeGenerations.userBookId, graph.userBookId),
        eq(nodeGenerations.generationScope, 'formal'),
      ));

    expect(replay.strategyVersionId).toBe(committedStrategies[0]?.id);
    expect(replayedStrategies.map(({ id }) => id)).toEqual(
      committedStrategies.map(({ id }) => id),
    );
    expect(new Set(replayedGenerations.map(({ id }) => id))).toEqual(
      new Set(committedGenerations.map(({ id }) => id)),
    );
    expect(new Set(replayEnqueueIds)).toEqual(
      new Set(committedGenerations.map(({ id }) => id)),
    );
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
