/** Verifies session serialization and low-level Agent loop message boundaries. */

import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import {
  runReadingSetupAgentLoop,
} from './reading-setup-session';
import {
  AgentSessionCodecError,
  createAgentSessionState,
  createOpenAiCompatibleAgentModel,
  restoreAgentContext,
  serializeAgentMessage,
} from './runtime';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
});

describe('reading setup Agent session codec', () => {
  it('preserves full SDK messages and reconstructs context from JSON', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: 'hello', timestamp: 1 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'reasoning', thinkingSignature: 'thinking-sig' },
          { type: 'text', text: 'answer', textSignature: 'text-sig' },
          { type: 'toolCall', id: 'tool-1', name: 'read_book_node', arguments: { offset: 4 } },
        ],
        api: 'openai-completions',
        provider: 'test-provider',
        model: 'test-model',
        responseId: 'response-1',
        usage: {
          input: 4,
          output: 5,
          cacheRead: 1,
          cacheWrite: 2,
          reasoning: 3,
          totalTokens: 12,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'read_book_node',
        content: [{ type: 'text', text: 'ok' }],
        details: { blocks: [{ blockIndex: 1, text: 'source' }] },
        isError: false,
        timestamp: 3,
      },
    ];
    const state = createAgentSessionState({
      systemPrompt: 'system',
      modelConfigId: 'model:config',
      thinkingLevel: 'high',
      messages,
    });
    const roundTrip = JSON.parse(JSON.stringify(state));
    const runtimeTool = {} as AgentTool;
    const context = restoreAgentContext(roundTrip, [runtimeTool]);
    expect(context.systemPrompt).toBe('system');
    expect(context.messages).toEqual(messages);
    expect(context.tools).toEqual([runtimeTool]);
    expect(roundTrip).not.toHaveProperty('model');
    expect(roundTrip).not.toHaveProperty('tools');
    expect(roundTrip).not.toHaveProperty('pendingToolCalls');
  });

  it('rejects functions, model objects and runtime collections in persisted details', () => {
    const invalid = {
      role: 'toolResult',
      toolCallId: 'tool-1',
      toolName: 'unsafe',
      content: [{ type: 'text', text: 'unsafe' }],
      details: { execute() {}, pending: new Set(['tool-1']), apiKey: Symbol('secret') },
      isError: false,
      timestamp: 1,
    } as unknown as AgentMessage;
    expect(() => serializeAgentMessage(invalid)).toThrow(AgentSessionCodecError);
  });
});

describe('reading setup Agent loop boundary', () => {
  it('finishes every tool in a mixed turn then stops after successful interaction tools', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = {
        id: 'chatcmpl-agent-run',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake-agent-model',
      };
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              { index: 0, id: 'read-1', type: 'function', function: { name: 'read_book_node', arguments: '{}' } },
              { index: 1, id: 'question-1', type: 'function', function: { name: 'present_question', arguments: '{}' } },
              { index: 2, id: 'offer-1', type: 'function', function: { name: 'offer_final_confirmation', arguments: '{}' } },
            ],
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
    if (!address || typeof address === 'string') throw new Error('server did not bind');

    const executed: string[] = [];
    const endedMessageRoles: string[] = [];
    const makeTool = (name: string): AgentTool => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}),
      execute: async (toolCallId) => {
        executed.push(toolCallId);
        return { content: [{ type: 'text', text: 'ok' }], details: { toolCallId } };
      },
    });
    const state = createAgentSessionState({
      systemPrompt: 'system',
      modelConfigId: 'fake-agent-model:test',
      thinkingLevel: 'medium',
    });
    const next = await runReadingSetupAgentLoop({
      state,
      input: { type: 'message', text: 'start' },
      model: createOpenAiCompatibleAgentModel({
        apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
        modelName: 'fake-agent-model',
      }),
      apiKey: 'test-key',
      tools: [
        makeTool('read_book_node'),
        makeTool('present_question'),
        makeTool('offer_final_confirmation'),
      ],
      emit: (event) => {
        if (event.type === 'message_end') endedMessageRoles.push(event.message.role);
      },
    });

    expect(requests).toBe(1);
    expect(executed).toEqual(expect.arrayContaining(['read-1', 'question-1', 'offer-1']));
    expect(executed).toHaveLength(3);
    expect(next.messages.filter((message) => message.role === 'toolResult')).toHaveLength(3);
    expect(endedMessageRoles.filter((role) => role === 'toolResult')).toHaveLength(3);
  });
});
