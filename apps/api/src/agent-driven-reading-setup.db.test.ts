/** Verifies reading-setup action admission, target resolution, and session observation. */

import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionState } from '@readtailor/contracts';
import {
  createReadingSetupSessionStore,
  userBooks,
} from '@readtailor/database';
import type { AgentRunObserver, AgentRunQueue } from '@readtailor/queue';
import { createAgentDrivenReadingSetupService } from './agent-driven-reading-setup';
import {
  getTestDatabase,
  hasTestDatabase,
  onShelfGraph,
  strategyReviewGraph,
} from './test/database';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

function completedState(): AgentSessionState {
  const calls = [
    { id: 'strategy-call', name: 'publish_strategy' },
    { id: 'trial-call', name: 'generate_trial_slice' },
  ];
  return {
    systemPrompt: 'reading setup system prompt',
    modelConfigId: 'test-model:test-prompt',
    thinkingLevel: 'medium',
    messages: [
      {
        role: 'assistant',
        content: calls.map((call) => ({
          type: 'toolCall' as const,
          id: call.id,
          name: call.name,
          arguments: {},
        })),
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
      ...calls.map((call) => ({
        role: 'toolResult' as const,
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: 'text' as const, text: 'ok' }],
        details: { toolCallId: call.id },
        isError: false,
        timestamp: 2,
      })),
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
  const queue = overrides?.queue ?? ({
    add: async () => undefined,
  } as unknown as AgentRunQueue);
  const observer = overrides?.observer ?? ({
    getRun: async () => null,
    subscribe: () => () => undefined,
  } as unknown as AgentRunObserver);
  return createAgentDrivenReadingSetupService({
    db: getTestDatabase().db,
    queue,
    observer,
    initialState: () => initialState,
  });
}

describePostgres(`Agent-driven reading setup actions${skipReason}`, () => {
  it('allows only one parallel API submission and enqueues the claimed run once', async () => {
    const graph = await onShelfGraph(getTestDatabase().db);
    const add = vi.fn(async () => undefined);
    const setup = service(completedState(), {
      queue: { add } as unknown as AgentRunQueue,
    });
    const session = await setup.getOrCreateSession(graph.userId, graph.userBookId);

    const responses = await Promise.all([
      setup.submitAction(graph.userId, session.id, {
        type: 'message',
        text: '第一条消息',
      }),
      setup.submitAction(graph.userId, session.id, {
        type: 'message',
        text: '并发消息',
      }),
    ]);

    expect(responses.filter((response) => response.accepted)).toHaveLength(1);
    expect(responses.filter((response) => !response.accepted)).toHaveLength(1);
    expect(new Set(responses.map((response) => response.runId))).toHaveLength(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('resolves feedback and confirmation target names from successful Tool calls', async () => {
    const graph = await onShelfGraph(getTestDatabase().db);
    const queued: unknown[] = [];
    const setup = service(completedState(), {
      queue: {
        add: async (_name: string, payload: unknown) => {
          queued.push(payload);
        },
      } as unknown as AgentRunQueue,
    });
    const session = await setup.getOrCreateSession(graph.userId, graph.userBookId);

    await setup.submitAction(graph.userId, session.id, {
      type: 'feedback',
      targetToolCallId: 'strategy-call',
      message: '  请增加例子  ',
    });
    expect(queued[0]).toMatchObject({
      input: {
        type: 'feedback',
        targetToolCallId: 'strategy-call',
        targetToolName: 'publish_strategy',
        message: '请增加例子',
      },
    });

    const runId = (queued[0] as { runId: string }).runId;
    const store = createReadingSetupSessionStore({
      db: getTestDatabase().db,
    });
    await store.failRun(session.id, runId);

    await setup.submitAction(graph.userId, session.id, {
      type: 'confirmation',
      targetToolCallId: 'trial-call',
    });
    expect(queued[1]).toMatchObject({
      input: {
        type: 'confirmation',
        targetToolCallId: 'trial-call',
        targetToolName: 'generate_trial_slice',
      },
    });
  });

  it('rejects feedback or confirmation whose target is not an allowed successful Tool', async () => {
    const graph = await onShelfGraph(getTestDatabase().db);
    const setup = service(completedState());
    const session = await setup.getOrCreateSession(graph.userId, graph.userBookId);

    await expect(setup.submitAction(graph.userId, session.id, {
      type: 'confirmation',
      targetToolCallId: 'missing-call',
    })).rejects.toThrow('可操作的成功 Tool');
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
});
