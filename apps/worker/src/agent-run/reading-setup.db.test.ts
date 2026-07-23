/** Exercises reading-setup Agent resources and the queued end-to-end flow against PostgreSQL. */

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  AgentJsonValue,
  AgentRunJobPayload,
  AgentSessionState,
  BookReaderProfile,
  ProposedStrategy,
} from '@readtailor/contracts';
import { createAgentSessionState } from '@readtailor/agent-kit/runtime';
import {
  bookProfiles,
  nodeGenerations,
  readingSetupOperations,
  trialRevisions,
  trialSegments,
  userBooks,
} from '@readtailor/database';
import type { ModelEngine } from '@readtailor/model';
import type { AgentRunObserver, AgentRunQueue, AgentRunQueueJob } from '@readtailor/queue';
import type { ReadingManifest } from '@readtailor/reader-core';
import { FileSystemObjectStorage } from '@readtailor/storage';
import {
  createAgentDrivenReadingSetupService,
} from '../../../api/src/agent-driven-reading-setup';
import type { BookService } from '../../../api/src/books';
import {
  getTestDatabase,
  hasTestDatabase,
  onShelfGraph,
} from '../../../api/src/test/database';
import { executeAgentRun } from './job';
import { createReadingSetupAgentTools } from './reading-setup';
import { createAgentHandlerRegistry } from './registry';
import { createReadingSetupAgentHandler } from './reading-setup-handler';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';
const temporaryRoots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all([
    ...temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    ...servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  ]);
});

const html = `<!doctype html><html><body><main id="book" data-type="book">
  <section id="bodymatter" data-role="bodymatter">
    <section id="chapter-1" data-type="chapter">
      <h1>第一章</h1>
      <p>系统由相互协作的部件组成，理解边界比记住术语更重要。</p>
      <p>第二段用于验证连续范围与分页读取。</p>
    </section>
  </section>
</main></body></html>`;

const firstText = '系统由相互协作的部件组成，理解边界比记住术语更重要。';
const secondText = '第二段用于验证连续范围与分页读取。';
const manifest: ReadingManifest = {
  version: 'reading-nodes-1.0',
  tailoringEligibilityVersion: 'tailoring-eligibility-1.0',
  document: { title: '数据库测试书籍', language: 'zh' },
  outline: [
    {
      sectionId: 'chapter-1',
      dataType: 'chapter',
      title: '第一章',
      parentSectionId: null,
      firstNodeOrder: 1,
    },
  ],
  bookTotalCharacters: firstText.length + secondText.length,
  nodeCount: 1,
  nodes: [
    {
      sectionId: 'chapter-1',
      segment: 1,
      order: 1,
      region: 'body',
      dataType: 'chapter',
      title: '第一章',
      parentSectionId: null,
      characterCount: firstText.length + secondText.length,
      blockCount: 2,
      tailoringEligible: true,
      exclusionReason: null,
      nodeAbsoluteStart: 0,
      blocks: [
        {
          blockIndex: 1,
          kind: 'paragraph',
          blockAbsoluteStart: 0,
          blockUtf16Length: firstText.length,
        },
        {
          blockIndex: 2,
          kind: 'paragraph',
          blockAbsoluteStart: firstText.length,
          blockUtf16Length: secondText.length,
        },
      ],
    },
  ],
  warnings: [],
  validation: { isValid: true, errorCount: 0, warningCount: 0 },
};

const profile: BookReaderProfile = {
  purpose: '理解系统方法',
  existingKnowledge: [],
  desiredDepthOrOutcome: '能够应用',
  likelyObstacles: [],
  expectedCommitment: '每天半小时',
  otherConclusions: [],
};

const strategy: ProposedStrategy = {
  goals: ['理解边界'],
  expressionPrinciples: ['简洁'],
  guide: { enabled: true, objectives: ['指出结构'] },
  annotations: { enabled: true, focuses: ['边界'], exclusions: [] },
  afterReading: { enabled: true, objectives: ['迁移应用'] },
};

function state(): AgentSessionState {
  return {
    systemPrompt: 'system',
    modelConfigId: 'model:prompt',
    thinkingLevel: 'medium',
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'profile-call',
            name: 'publish_book_reader_profile',
            arguments: { profile },
          },
          {
            type: 'toolCall',
            id: 'strategy-call',
            name: 'publish_strategy',
            arguments: { summary: '测试策略', strategy },
          },
        ],
        api: 'openai-completions',
        provider: 'test',
        model: 'test',
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
      {
        role: 'toolResult',
        toolCallId: 'profile-call',
        toolName: 'publish_book_reader_profile',
        content: [{ type: 'text', text: 'ok' }],
        details: { toolCallId: 'profile-call', profile },
        isError: false,
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'strategy-call',
        toolName: 'publish_strategy',
        content: [{ type: 'text', text: 'ok' }],
        details: { toolCallId: 'strategy-call', summary: '测试策略', strategy },
        isError: false,
        timestamp: 3,
      },
    ],
    actions: [],
  };
}

function toolByName(all: AgentTool[], name: string): AgentTool {
  const tool = all.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

async function prepareResources() {
  const db = getTestDatabase().db;
  const graph = await onShelfGraph(db);
  const root = await mkdtemp(join(tmpdir(), 'readtailor-agent-e2e-'));
  temporaryRoots.push(root);
  const storage = new FileSystemObjectStorage(root);
  const prefix = `test/${graph.sharedBookId}`;
  const profileKey = `${prefix}/book_profile.json`;
  const bookProfile = new TextEncoder().encode(JSON.stringify({ themes: ['系统'] }));
  await Promise.all([
    storage.put(`${prefix}/book.normalized.html`, new TextEncoder().encode(html)),
    storage.put(
      `${prefix}/reading_manifest.json`,
      new TextEncoder().encode(JSON.stringify(manifest)),
    ),
    storage.put(profileKey, bookProfile),
  ]);
  await db.insert(bookProfiles).values({
    packageId: graph.packageId,
    objectKey: profileKey,
    sha256: createHash('sha256').update(bookProfile).digest('hex'),
  });
  return { db, graph, storage };
}

async function execute(
  tool: AgentTool,
  id: string,
  input: Record<string, unknown>,
) {
  return (tool.execute as unknown as (
    toolCallId: string,
    argumentsValue: Record<string, unknown>,
  ) => Promise<{ details: AgentJsonValue }>)(id, input);
}

describePostgres(`reading setup Agent resource tools${skipReason}`, () => {
  it('reads bounded pages, rejects invalid ranges, generates one in-memory slice and cannot activate the book', async () => {
    const { db, graph, storage } = await prepareResources();
    const all = createReadingSetupAgentTools({
      db,
      storage,
      tailoringModel: { name: 'fake' } as ModelEngine,
      userBookId: graph.userBookId,
      state: state(),
    }).tools;

    const page = await execute(toolByName(all, 'read_book_node'), 'read-call', {
      sectionId: 'chapter-1',
      segment: 1,
      maxCharacters: 8,
    });
    expect(page.details).toMatchObject({
      sectionId: 'chapter-1',
      segment: 1,
      truncated: true,
      nextStart: { blockIndex: 1, offset: 8 },
    });
    expect(JSON.stringify(page.details).length).toBeLessThan(50 * 1024);

    await expect(
      execute(toolByName(all, 'generate_trial_slice'), 'invalid-trial', {
        strategyToolCallId: 'strategy-call',
        sectionId: 'chapter-1',
        segment: 1,
        range: {
          start: { blockIndex: 2, offset: 1 },
          end: { blockIndex: 1, offset: 2 },
        },
        reason: '无效反向范围',
      }),
    ).rejects.toThrow();

    const trial = await execute(toolByName(all, 'generate_trial_slice'), 'trial-call', {
      strategyToolCallId: 'strategy-call',
      sectionId: 'chapter-1',
      segment: 1,
      range: {
        start: { blockIndex: 1, offset: 0 },
        end: { blockIndex: 2, offset: secondText.length },
      },
      reason: '验证完整策略',
    });
    expect(trial.details).toMatchObject({
      toolCallId: 'trial-call',
      strategyToolCallId: 'strategy-call',
      source: {
        sectionId: 'chapter-1',
        segment: 1,
        text: expect.stringContaining('系统由相互协作'),
      },
      guide: expect.any(String),
      annotations: [],
      afterReading: expect.any(String),
    });

    const forbiddenRows = await Promise.all([
      db.select().from(trialRevisions),
      db.select().from(trialSegments),
      db.select().from(nodeGenerations),
      db.select().from(readingSetupOperations),
    ]);
    expect(forbiddenRows.map((rows) => rows.length)).toEqual([0, 0, 0, 0]);
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    expect(book).toMatchObject({
      workflowStatus: 'on_shelf',
      currentStrategyVersionId: null,
      currentTrialRevisionId: null,
    });
  });

  it('runs fake Agent/model from API actions through Worker, revision feedback, confirmation and Reader activation', async () => {
    const { db, graph, storage } = await prepareResources();
    const responses = [
      [
        {
          id: 'question-1',
          name: 'present_question',
          arguments: {
            prompt: '你最想从这本书获得什么？',
            options: [{ id: 'apply', label: '用于实际项目' }],
            selectionMode: 'single',
            allowFreeText: true,
          },
        },
      ],
      [
        { id: 'brief-1', name: 'publish_brief', arguments: { brief: {
          bookIdentity: '一本讲系统边界的书',
          arc: '从组件走向协作',
          assumedKnowledge: '无',
          readingAdvice: '结合实际项目阅读',
        } } },
        {
          id: 'profile-1',
          name: 'publish_book_reader_profile',
          arguments: { profile },
        },
        {
          id: 'strategy-1',
          name: 'publish_strategy',
          arguments: { summary: '先理解系统边界。', strategy },
        },
        {
          id: 'question-2',
          name: 'present_question',
          arguments: {
            prompt: '这个方案还需要怎样调整？',
            options: [{ id: 'more-examples', label: '增加工程例子' }],
            selectionMode: 'single',
            allowFreeText: true,
          },
        },
      ],
      [
        {
          id: 'strategy-2',
          name: 'publish_strategy',
          arguments: {
            summary: '增加工程例子后再解释系统边界。',
            strategy: {
              ...strategy,
              expressionPrinciples: ['简洁', '先给工程例子'],
            },
          },
        },
      ],
      [
        {
          id: 'trial-2',
          name: 'generate_trial_slice',
          arguments: {
            strategyToolCallId: 'strategy-2',
            sectionId: 'chapter-1',
            segment: 1,
            range: {
              start: { blockIndex: 1, offset: 0 },
              end: { blockIndex: 2, offset: secondText.length },
            },
            reason: '验证调整后的表达方式',
          },
        },
        {
          id: 'offer-2',
          name: 'offer_final_confirmation',
          arguments: {
            briefToolCallId: 'brief-1',
            bookReaderProfileToolCallId: 'profile-1',
            strategyToolCallId: 'strategy-2',
            trialToolCallId: 'trial-2',
            summary: '调整后的方案和试读已准备完成。',
          },
        },
      ],
    ];
    let modelRequest = 0;
    const server = createServer((_request, response) => {
      const calls = responses[modelRequest++];
      if (!calls) {
        response.writeHead(500).end('unexpected model request');
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = {
        id: `chatcmpl-${modelRequest}`,
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake-reading-agent',
      };
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fake model did not bind');

    const queued: AgentRunJobPayload[] = [];
    const queue = {
      add: async (_name: string, payload: AgentRunJobPayload) => {
        queued.push(payload);
      },
    } as unknown as AgentRunQueue;
    const observer = {
      getRun: async () => null,
      subscribe: () => () => undefined,
    } as unknown as AgentRunObserver;
    const setup = createAgentDrivenReadingSetupService({
      db,
      books: { getManifest: async () => manifest } as unknown as BookService,
      queue,
      observer,
      initialState: () => createAgentSessionState({
        systemPrompt: '自主完成阅读准备',
        modelConfigId: 'fake-reading-agent:test',
        thinkingLevel: 'medium',
      }),
    });
    const registry = createAgentHandlerRegistry([
      createReadingSetupAgentHandler({
        db,
        storage,
        apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'test-key',
        modelName: 'fake-reading-agent',
        tailoringModel: { name: 'fake' } as ModelEngine,
      }),
    ]);
    const runNext = async () => {
      const payload = queued.shift();
      if (!payload) throw new Error('expected queued Agent run');
      const jobData: {
        data: AgentRunJobPayload;
        progress: unknown;
        updateProgress(progress: unknown): Promise<void>;
      } = {
        data: payload,
        progress: 0,
        updateProgress: async (progress: unknown) => {
          jobData.progress = progress;
        },
      };
      const job = jobData as unknown as AgentRunQueueJob;
      await executeAgentRun({ registry, job });
    };

    const session = await setup.getOrCreateSession(graph.userId, graph.userBookId);
    await setup.submitMessage(graph.userId, session.id, '开始准备');
    await runNext();
    await setup.submitQuestionAnswer(graph.userId, session.id, {
      questionToolCallId: 'question-1',
      selectedOptionIds: ['apply'],
      freeText: null,
    });
    await runNext();
    await setup.submitQuestionAnswer(graph.userId, session.id, {
      questionToolCallId: 'question-2',
      selectedOptionIds: ['more-examples'],
      freeText: '请优先使用软件工程例子',
    });
    await runNext();

    const committed = await setup.getSession(graph.userId, session.id);
    const successfulToolCallIds = committed.agentState.messages.flatMap((message) =>
      message.role === 'toolResult' && !message.isError ? [message.toolCallId] : [],
    );
    expect(successfulToolCallIds).toEqual(
      expect.arrayContaining([
        'question-1',
        'brief-1',
        'profile-1',
        'strategy-1',
        'question-2',
        'strategy-2',
        'trial-2',
        'offer-2',
      ]),
    );
    expect(modelRequest).toBe(4);

    const activated = await setup.confirm(graph.userId, session.id, 'offer-2');
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));
    expect(activated).toMatchObject({ workflowStatus: 'active_reading' });
    expect(book).toMatchObject({
      workflowStatus: 'active_reading',
      currentStrategyVersionId: activated.strategyVersionId,
      currentTrialRevisionId: null,
    });
  });
});
