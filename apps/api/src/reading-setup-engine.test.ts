import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentCallPerfEvent, PerfSink } from '@readtailor/observability';
import { createAgentReadingSetupEngine } from './reading-setup-engine';

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
    const server = createServer((_request, response) => {
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
    const streamEventTypes: string[] = [];
    const result = await engine.runTurn({
      sessionId: 'session-1',
      phase: 'interviewing',
      askedCount: 1,
      conversationVersion: 7,
      requestId: 'request-1',
      context: { book: { title: 'Book' } },
      onStream: (event) => streamEventTypes.push(event.type),
    });

    expect(result).toEqual({ type: 'question', question });
    expect(streamEventTypes).not.toContain('concluding');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      requestId: 'request-1',
      sessionId: 'session-1',
      conversationVersion: 7,
      kind: 'reading_setup.interviewing',
      status: 'ok',
      turnCount: 2,
    });

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
