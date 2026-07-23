/** Verifies final reading activation and session invariants against PostgreSQL. */

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type {
  AgentSessionState,
  BookReaderProfile,
  Briefing,
  ProposedStrategy,
} from '@readtailor/contracts';
import {
  readingSetupSessions,
  bookReaderProfileVersions,
  interviewAnswers,
  interviewMessages,
  interviewSessions,
  nodeGenerations,
  readingSetupOperations,
  strategyDraftVersions,
  strategyVersions,
  trialRevisions,
  trialSegments,
  userBooks,
} from '@readtailor/database';
import type { AgentRunObserver, AgentRunQueue } from '@readtailor/queue';
import type { ReadingManifest } from '@readtailor/reader-core';
import { createAgentDrivenReadingSetupService } from './agent-driven-reading-setup';
import type { BookService } from './books';
import {
  getTestDatabase,
  hasTestDatabase,
  onShelfGraph,
  strategyReviewGraph,
} from './test/database';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

const brief: Briefing = {
  bookIdentity: '一本解释复杂系统的书',
  arc: '从局部机制走向整体协作',
  assumedKnowledge: '不要求专业背景',
  readingAdvice: '先抓住主线，再回看细节',
};

const profile: BookReaderProfile = {
  purpose: '理解并应用书中的系统方法',
  existingKnowledge: ['了解基础软件设计'],
  desiredDepthOrOutcome: '能把方法用于真实项目',
  likelyObstacles: ['时间有限'],
  expectedCommitment: '每天三十分钟',
  otherConclusions: ['偏好先例子后概念'],
};

const strategy: ProposedStrategy = {
  goals: ['建立全书结构', '迁移关键方法'],
  expressionPrinciples: ['简洁', '结合工程例子'],
  guide: { enabled: true, objectives: ['指出段落在全书中的作用'] },
  annotations: { enabled: true, focuses: ['核心概念'], exclusions: ['常识性背景'] },
  afterReading: { enabled: true, objectives: ['总结并给出应用问题'] },
};

const manifest: ReadingManifest = {
  version: 'reading-nodes-1.0',
  tailoringEligibilityVersion: 'tailoring-eligibility-1.0',
  document: { title: '数据库测试书籍', language: 'zh' },
  outline: [
    {
      sectionId: 'chapter-1',
      dataType: 'bodymatter',
      title: '第一章',
      parentSectionId: null,
      firstNodeOrder: 1,
    },
  ],
  bookTotalCharacters: 120,
  nodeCount: 1,
  nodes: [
    {
      sectionId: 'chapter-1',
      segment: 1,
      order: 1,
      region: 'body',
      dataType: 'bodymatter',
      title: '第一章',
      parentSectionId: null,
      characterCount: 120,
      blockCount: 1,
      tailoringEligible: true,
      exclusionReason: null,
      nodeAbsoluteStart: 0,
      blocks: [
        {
          blockIndex: 1,
          kind: 'paragraph',
          blockAbsoluteStart: 0,
          blockUtf16Length: 120,
        },
      ],
    },
  ],
  warnings: [],
  validation: { isValid: true, errorCount: 0, warningCount: 0 },
};

const callIds = {
  brief: 'brief-call',
  profile: 'profile-call',
  strategy: 'strategy-call',
  trial: 'trial-call',
  offer: 'offer-call',
} as const;

function completedState(trialStrategyToolCallId: string = callIds.strategy): AgentSessionState {
  const calls = [
    { id: callIds.brief, name: 'publish_brief', arguments: { brief } },
    {
      id: callIds.profile,
      name: 'publish_book_reader_profile',
      arguments: { profile },
    },
    {
      id: callIds.strategy,
      name: 'publish_strategy',
      arguments: { summary: '围绕系统主线精读，并把方法迁移到工程实践。', strategy },
    },
    {
      id: callIds.trial,
      name: 'generate_trial_slice',
      arguments: {
        strategyToolCallId: callIds.strategy,
        sectionId: 'chapter-1',
        segment: 1,
        range: {
          start: { blockIndex: 1, offset: 0 },
          end: { blockIndex: 1, offset: 100 },
        },
        reason: '验证策略是否适合用户',
      },
    },
    {
      id: callIds.offer,
      name: 'offer_final_confirmation',
      arguments: {
        briefToolCallId: callIds.brief,
        bookReaderProfileToolCallId: callIds.profile,
        strategyToolCallId: callIds.strategy,
        trialToolCallId: callIds.trial,
        summary: '已准备好正式阅读方案。',
      },
    },
  ];
  const results = calls.map((call) => ({
    role: 'toolResult' as const,
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: 'text' as const, text: 'ok' }],
    details:
      call.name === 'generate_trial_slice'
        ? {
            strategyToolCallId: trialStrategyToolCallId,
            source: { sectionId: 'chapter-1', segment: 1 },
            guide: '导读',
            annotations: [],
            afterReading: '读后问题',
          }
        : { toolCallId: call.id },
    isError: false,
    timestamp: 2,
  }));
  return {
    systemPrompt: 'reading setup system prompt',
    modelConfigId: 'test-model:test-prompt',
    thinkingLevel: 'medium',
    messages: [
      {
        role: 'assistant',
        content: calls.map((call) => ({ type: 'toolCall' as const, ...call })),
        api: 'openai-completions',
        provider: 'test',
        model: 'test-model',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 1,
      },
      ...results,
    ],
    actions: [],
  };
}

function service(
  initialState: AgentSessionState,
  overrides?: {
    queue?: AgentRunQueue;
    observer?: AgentRunObserver;
  },
) {
  const db = getTestDatabase().db;
  const books = {
    getManifest: async () => manifest,
  } as unknown as BookService;
  const queue = overrides?.queue ?? ({
    add: async () => undefined,
  } as unknown as AgentRunQueue);
  const observer = overrides?.observer ?? ({
    getRun: async () => null,
    subscribe: () => () => undefined,
  } as unknown as AgentRunObserver);
  return createAgentDrivenReadingSetupService({
    db,
    books,
    queue,
    observer,
    initialState: () => initialState,
  });
}

describePostgres(`Agent-driven reading setup final confirmation${skipReason}`, () => {
  it('allows only one parallel API submission and enqueues the claimed run once', async () => {
    const db = getTestDatabase().db;
    const graph = await onShelfGraph(db);
    const add = vi.fn(async () => undefined);
    const setup = service(completedState(), {
      queue: { add } as unknown as AgentRunQueue,
    });
    const session = await setup.getOrCreateSession(graph.userId, graph.userBookId);

    const responses = await Promise.all([
      setup.submitMessage(graph.userId, session.id, '第一条消息'),
      setup.submitMessage(graph.userId, session.id, '并发消息'),
    ]);

    expect(responses.filter((response) => response.accepted)).toHaveLength(1);
    expect(responses.filter((response) => !response.accepted)).toHaveLength(1);
    expect(new Set(responses.map((response) => response.runId))).toHaveLength(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('sends the authoritative SSE snapshot before buffered newer events and only unsubscribes on disconnect', async () => {
    const graph = await onShelfGraph(getTestDatabase().db);
    const runId = '00000000-0000-0000-0000-000000000099';
    const unsubscribe = vi.fn();
    let sessionId = '';
    const observer = {
      subscribe: (_runId: string, listener: (progress: unknown) => void) => {
        listener({
          snapshot: {
            runId,
            lastSequence: 2,
            status: 'running',
            assistantText: '新',
            assistantMessage: null,
            tools: [],
            error: null,
          },
          event: {
            type: 'assistant_text_delta',
            runId,
            sequence: 2,
            delta: '新',
          },
        });
        return unsubscribe;
      },
      getRun: async () => ({
        payload: {
          agentType: 'reading_setup' as const,
          sessionId,
          runId,
          input: { type: 'message' as const, text: 'start' },
        },
        status: 'active',
        progress: {
          snapshot: {
            runId,
            lastSequence: 1,
            status: 'running' as const,
            assistantText: '',
            assistantMessage: null,
            tools: [],
            error: null,
          },
          event: {
            type: 'assistant_text_delta' as const,
            runId,
            sequence: 1,
            delta: '',
          },
        },
      }),
    } as unknown as AgentRunObserver;
    const setup = service(completedState(), { observer });
    const session = await setup.getOrCreateSession(graph.userId, graph.userBookId);
    sessionId = session.id;
    const stream = setup.subscribeRun(graph.userId, session.id, runId);

    expect((await stream.next()).value).toMatchObject({
      type: 'run_snapshot',
      snapshot: { lastSequence: 1 },
    });
    expect((await stream.next()).value).toMatchObject({
      type: 'assistant_text_delta',
      sequence: 2,
      delta: '新',
    });
    await stream.return(undefined);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh session when stale legacy setup pointers remain on an on-shelf book', async () => {
    const db = getTestDatabase().db;
    const graph = await strategyReviewGraph(db);
    await db
      .update(userBooks)
      .set({ workflowStatus: 'on_shelf' })
      .where(eq(userBooks.id, graph.userBookId));

    const snapshot = await service(completedState()).getOrCreateSession(
      graph.userId,
      graph.userBookId,
    );

    expect(snapshot.userBookId).toBe(graph.userBookId);
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    expect(book).toMatchObject({
      workflowStatus: 'on_shelf',
      currentInterviewSessionId: graph.interviewSessionId,
      currentStrategyDraftVersionId: graph.strategyDraftVersionId,
    });
  });

  it('atomically writes only the compatibility chain and replays confirmation idempotently', async () => {
    const db = getTestDatabase().db;
    const graph = await onShelfGraph(db);
    const setup = service(completedState());
    const session = await setup.getOrCreateSession(graph.userId, graph.userBookId);

    expect(
      await db
        .select()
        .from(strategyVersions)
        .where(eq(strategyVersions.userBookId, graph.userBookId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(bookReaderProfileVersions)
        .where(eq(bookReaderProfileVersions.userBookId, graph.userBookId)),
    ).toHaveLength(0);

    const first = await setup.confirm(graph.userId, session.id, callIds.offer);
    const replay = await setup.confirm(graph.userId, session.id, callIds.offer);

    expect(replay).toEqual(first);
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    const interviews = await db
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.userBookId, graph.userBookId));
    const profiles = await db
      .select()
      .from(bookReaderProfileVersions)
      .where(eq(bookReaderProfileVersions.userBookId, graph.userBookId));
    const drafts = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId));
    const formal = await db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.userBookId, graph.userBookId));
    expect(book).toMatchObject({
      workflowStatus: 'active_reading',
      currentInterviewSessionId: interviews[0]!.id,
      currentBookReaderProfileVersionId: profiles[0]!.id,
      currentStrategyDraftVersionId: drafts[0]!.id,
      currentStrategyVersionId: formal[0]!.id,
      currentTrialRevisionId: null,
    });
    expect(interviews).toHaveLength(1);
    expect(interviews[0]).toMatchObject({ status: 'completed', questionCount: 0 });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ version: 1, profile });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      version: 1,
      status: 'confirmed',
      readingBriefing: brief,
      strategy: {
        ...strategy,
        trialCandidates: [
          { sectionId: 'chapter-1', segment: 1, reason: expect.any(String) },
          { sectionId: 'chapter-1', segment: 1, reason: expect.any(String) },
          { sectionId: 'chapter-1', segment: 1, reason: expect.any(String) },
        ],
      },
    });
    expect(formal).toHaveLength(1);

    const [persistedSession] = await db
      .select()
      .from(readingSetupSessions)
      .where(eq(readingSetupSessions.id, session.id));
    expect(persistedSession?.agentState.actions).toEqual([
      expect.objectContaining({
        type: 'final_confirmation',
        offerToolCallId: callIds.offer,
        result: first,
      }),
    ]);

    const forbiddenCounts = await Promise.all([
      db.select().from(interviewMessages),
      db.select().from(interviewAnswers),
      db.select().from(trialRevisions),
      db.select().from(trialSegments),
      db.select().from(nodeGenerations),
      db.select().from(readingSetupOperations),
    ]);
    expect(forbiddenCounts.map((rows) => rows.length)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('rolls back without formal rows when the trial was generated from another strategy', async () => {
    const db = getTestDatabase().db;
    const graph = await onShelfGraph(db);
    const setup = service(completedState('different-strategy-call'));
    const session = await setup.getOrCreateSession(graph.userId, graph.userBookId);

    await expect(setup.confirm(graph.userId, session.id, callIds.offer)).rejects.toThrow(
      '试读使用的 strategy 与确认引用不一致',
    );
    expect(
      await db
        .select()
        .from(interviewSessions)
        .where(eq(interviewSessions.userBookId, graph.userBookId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(bookReaderProfileVersions)
        .where(eq(bookReaderProfileVersions.userBookId, graph.userBookId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(strategyDraftVersions)
        .where(eq(strategyDraftVersions.userBookId, graph.userBookId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(strategyVersions)
        .where(eq(strategyVersions.userBookId, graph.userBookId)),
    ).toHaveLength(0);
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    expect(book?.workflowStatus).toBe('on_shelf');
  });

  it('reuses legacy shells, allocates the next versions and activates pointers readable by Reader', async () => {
    const db = getTestDatabase().db;
    const graph = await strategyReviewGraph(db);
    await db
      .update(userBooks)
      .set({ workflowStatus: 'on_shelf' })
      .where(eq(userBooks.id, graph.userBookId));
    const setup = service(completedState());
    const session = await setup.getOrCreateSession(graph.userId, graph.userBookId);

    const result = await setup.confirm(graph.userId, session.id, callIds.offer);

    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    const profiles = await db
      .select()
      .from(bookReaderProfileVersions)
      .where(eq(bookReaderProfileVersions.userBookId, graph.userBookId));
    const drafts = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.userBookId, graph.userBookId));
    const formal = await db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.userBookId, graph.userBookId));
    expect(profiles.map((item) => item.version).sort()).toEqual([1, 2]);
    expect(drafts.map((item) => item.version).sort()).toEqual([1, 2]);
    expect(formal.map((item) => item.version)).toEqual([1]);
    expect(book).toMatchObject({
      workflowStatus: 'active_reading',
      currentInterviewSessionId: graph.interviewSessionId,
      currentBookReaderProfileVersionId: profiles.find((item) => item.version === 2)?.id,
      currentStrategyDraftVersionId: drafts.find((item) => item.version === 2)?.id,
      currentStrategyVersionId: result.strategyVersionId,
    });
  });
});
