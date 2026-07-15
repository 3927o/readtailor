import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompletionSnapshot, InterviewCompletionStore } from '@readtailor/agent-kit';
import type { AgentCallPerfEvent, PerfSink } from '@readtailor/observability';
import { createAgentReadingSetupEngine, createFakeReadingSetupEngine } from './reading-setup-engine';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

function writeToolCall(
  response: ServerResponse,
  input: { requestNo: number; callId: string; name: string; arguments: unknown },
): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = {
    id: `chatcmpl-reading-${input.requestNo}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake-tool-model',
  };
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: input.callId,
          type: 'function',
          function: { name: input.name, arguments: JSON.stringify(input.arguments) },
        }],
      },
      finish_reason: null,
    }],
  })}\n\n`);
  response.write(`data: ${JSON.stringify({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  })}\n\n`);
  response.end('data: [DONE]\n\n');
}

describe('createAgentReadingSetupEngine', () => {
  it('emits epoch-aware strategy revision deltas in fake mode', async () => {
    const engine = createFakeReadingSetupEngine();
    const eventTypes: string[] = [];
    const outcome = await engine.runTurn({
      sessionId: 'session-fake',
      phase: 'strategy_review',
      askedCount: 0,
      feedback: '更简短',
      context: {
        book: { title: 'Book' },
        bookProfile: {
          trial_candidates: [1, 2, 3].map((segment) => ({
            section_id: 'chapter-1',
            segment,
            reason: `reason-${segment}`,
          })),
        },
      },
      onStream: (event) => eventTypes.push(event.type),
    });

    expect(outcome.type).toBe('revised');
    expect(eventTypes).toEqual([
      'speculative_reset',
      'draft_started',
      'strategy_delta',
      'reading_node_added',
      'reading_node_added',
      'reading_node_added',
    ]);
  });

  it('streams interview completion as briefing, strategy, then trial candidates', async () => {
    const engine = createFakeReadingSetupEngine();
    const eventTypes: string[] = [];
    let snapshot: CompletionSnapshot = { completionId: null, baseConversationVersion: 2 };
    const completionStore: InterviewCompletionStore = {
      load: vi.fn(async () => snapshot),
      start: vi.fn(async () => {
        snapshot = { ...snapshot, completionId: 'completion-1' };
        return snapshot;
      }),
      submitBriefing: vi.fn(async (briefing) => {
        snapshot = { ...snapshot, briefing };
        return snapshot;
      }),
      submitStrategy: vi.fn(async (strategy) => {
        snapshot = { ...snapshot, strategy };
        return snapshot;
      }),
      submitCandidates: vi.fn(async (candidates) => {
        snapshot = { ...snapshot, candidates };
        return snapshot;
      }),
      submitProfile: vi.fn(async (profile) => {
        snapshot = { ...snapshot, profile };
        return snapshot;
      }),
      complete: vi.fn(async () => ({
        briefing: snapshot.briefing!,
        strategy: snapshot.strategy!,
        candidates: snapshot.candidates!,
        profile: snapshot.profile!,
      })),
    };
    const outcome = await engine.runTurn({
      sessionId: 'session-fake',
      phase: 'interviewing',
      askedCount: 99,
      conversationVersion: 2,
      completionStore,
      context: {
        book: { title: 'Book' },
        bookProfile: {
          trial_candidates: [1, 2, 3].map((segment) => ({
            section_id: 'chapter-1',
            segment,
            reason: `reason-${segment}`,
          })),
        },
      },
      onStream: (event) => eventTypes.push(event.type),
    });

    expect(outcome.type).toBe('completed');
    expect(completionStore.start).toHaveBeenCalledOnce();
    expect(completionStore.submitBriefing).toHaveBeenCalledOnce();
    expect(completionStore.submitStrategy).toHaveBeenCalledOnce();
    expect(completionStore.submitCandidates).toHaveBeenCalledOnce();
    expect(completionStore.submitProfile).toHaveBeenCalledOnce();
    expect(completionStore.complete).toHaveBeenCalledOnce();
    expect(eventTypes).toEqual([
      'speculative_reset',
      'draft_started',
      'briefing_delta',
      'briefing_delta',
      'briefing_delta',
      'briefing_delta',
      'strategy_delta',
      'reading_node_added',
      'reading_node_added',
      'reading_node_added',
    ]);
  });

  it('streams all three trial fragments in fake mode', async () => {
    const engine = createFakeReadingSetupEngine();
    const events: Array<{ type: string; speculativeEpoch: number }> = [];
    const outcome = await engine.runTurn({
      sessionId: 'session-fake',
      phase: 'select_trial',
      askedCount: 0,
      context: {
        trialNodeContents: [1, 2, 3].map((segment) => ({
          section_id: 'chapter-1',
          segment,
          blocks: [{ block_index: 1, text: `candidate-${segment}` }],
        })),
      },
      onStream: (event) => events.push(event),
    });

    expect(outcome.type).toBe('fragments');
    expect(events.map((event) => event.type)).toEqual([
      'speculative_reset',
      'selection_started',
      'fragment_added',
      'fragment_added',
      'fragment_added',
    ]);
    expect(new Set(events.map((event) => event.speculativeEpoch))).toEqual(new Set([1]));
  });

  it('persists ordered, queryable tool traces without prompt or raw argument content', async () => {
    const question = {
      id: 'goal',
      acknowledgment: '明白了。',
      prompt: '你希望从这本书里得到什么？',
      options: [
        { id: 'understand', label: '建立理解' },
        { id: 'apply', label: '实际应用' },
      ],
      allow_text: true,
      profile_dimension: 'reading_goals',
      sufficiency: 40,
    };
    let requestNo = 0;
    let providerPromptChars = 0;
    let toolProperties = new Map<string, string[]>();
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const payload = JSON.parse(body) as { messages?: unknown; tools?: unknown };
      const promptPayload: Record<string, unknown> = {};
      if (payload.messages !== undefined) promptPayload.messages = payload.messages;
      if (payload.tools !== undefined) promptPayload.tools = payload.tools;
      const tools = Array.isArray(payload.tools) ? payload.tools as Array<{
        function?: { name?: string; parameters?: { properties?: Record<string, unknown> } };
      }> : [];
      toolProperties = new Map(tools.flatMap((tool) => tool.function?.name
        ? [[tool.function.name, Object.keys(tool.function.parameters?.properties ?? {})] as const]
        : []));
      providerPromptChars += JSON.stringify(promptPayload).length;
      requestNo += 1;
      if (requestNo === 1) {
        writeToolCall(response, {
          requestNo,
          callId: 'call-invalid-finish',
          name: 'finish_interview',
          arguments: {},
        });
        return;
      }
      writeToolCall(response, {
        requestNo,
        callId: 'call-question',
        name: 'present_interview_question',
        arguments: question,
      });
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const rows: AgentCallPerfEvent[] = [];
    const perfSink: PerfSink = {
      recordHttp() {},
      recordAgentCall(event) {
        rows.push(event);
      },
      async close() {},
    };
    const engine = createAgentReadingSetupEngine({
      apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      perfSink,
    });
    const result = await engine.runTurn({
      sessionId: 'session-1',
      phase: 'interviewing',
      askedCount: 1,
      conversationVersion: 7,
      requestId: 'request-1',
      context: { book: { title: 'Book' } },
    });

    expect(result).toEqual({ type: 'question', question });
    expect(toolProperties.get('finish_interview')).toEqual([]);
    expect(toolProperties.get('submit_reading_briefing')).toEqual([
      'book_identity',
      'arc',
      'assumed_knowledge',
      'reading_advice',
    ]);
    expect(toolProperties.get('submit_reading_strategy')).toEqual(['public_strategy', 'strategy']);
    expect(toolProperties.get('submit_trial_candidates')).toEqual(['candidates']);
    expect(toolProperties.get('submit_interview_profile')).toEqual([
      'book_reader_profile',
      'reader_profile_patch',
    ]);
    expect(toolProperties.get('complete_interview_result')).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: 'request-1',
      sessionId: 'session-1',
      conversationVersion: 7,
      kind: 'reading_setup.interviewing',
      status: 'ok',
      promptChars: expect.any(Number),
      outputChars: JSON.stringify({}).length + JSON.stringify(question).length,
      turnCount: 2,
    });
    expect(rows[0]!.promptChars).toBe(providerPromptChars);

    const trace = rows[0]!.traceEvents ?? [];
    expect(trace.map((event) => event.type)).toEqual([
      'agent_started',
      'turn_started',
      'assistant_message',
      'tool_started',
      'tool_finished',
      'turn_finished',
      'turn_started',
      'assistant_message',
      'tool_started',
      'tool_finished',
      'turn_finished',
      'agent_finished',
    ]);
    expect(trace.filter((event) => event.type === 'tool_finished')).toMatchObject([
      { turn: 1, toolName: 'finish_interview', succeeded: false },
      { turn: 2, toolName: 'present_interview_question', succeeded: true },
    ]);
    expect(trace.find((event) => event.type === 'tool_finished' && event.succeeded === false))
      .toEqual(expect.objectContaining({ errorSummary: expect.any(String) }));
    expect(trace[0]).not.toHaveProperty('prompt');
    expect(trace[0]).not.toHaveProperty('systemPrompt');
    expect(trace.find((event) => event.type === 'tool_started' && event.toolName === 'present_interview_question'))
      .toMatchObject({
        arguments: {
          keys: ['acknowledgment', 'allow_text', 'id', 'options', 'profile_dimension', 'prompt', 'sufficiency'],
          size: expect.any(Number),
        },
      });
  });
});
