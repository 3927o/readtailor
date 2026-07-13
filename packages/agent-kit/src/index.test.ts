import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runNormalizationAgent,
  type AgentTraceEvent,
  type NormalizationAgentToolbox,
  type NormalizationFinishBinding,
} from './index';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('normalization Pi Agent', () => {
  it('accepts completion only through the finish_normalization tool', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      });
      const base = {
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fake-tool-model',
      };
      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-finish',
                    type: 'function',
                    function: { name: 'finish_normalization', arguments: '{}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const binding: NormalizationFinishBinding = {
      sourceEpubSha256: 'd'.repeat(64),
      scriptSha256: 'a'.repeat(64),
      outputInventorySha256: 'b'.repeat(64),
      validatorVersion: 'nb-check-1.0',
      validationReportSha256: 'c'.repeat(64),
      blockingErrorCount: 0,
      warningCount: 3,
    };
    const unavailable = async () => {
      throw new Error('unexpected tool call');
    };
    const toolbox: NormalizationAgentToolbox = {
      runShell: unavailable,
      inspectEpubStructure: unavailable,
      writeNormalizer: unavailable,
      patchNormalizer: unavailable,
      runNormalizer: unavailable,
      runNbLinter: unavailable,
      runNbCheck: unavailable,
      finishNormalization: async () => binding,
    };
    const traces: AgentTraceEvent[] = [];

    const result = await runNormalizationAgent({
      apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      toolbox,
      sessionId: 'test-session',
      maxTurns: 2,
      timeoutMs: 5000,
      onTrace: (event) => {
        traces.push(event);
      },
    });

    expect(result.finishBinding).toEqual(binding);
    expect(result.turns).toBe(1);
    expect(result.toolCalls).toBe(1);
    expect(traces[0]).toMatchObject({
      type: 'agent_started',
      agentName: 'normalization',
      sessionId: 'test-session',
      modelName: 'fake-tool-model',
    });
    expect(traces).toContainEqual(
      expect.objectContaining({
        type: 'tool_started',
        toolName: 'finish_normalization',
        args: {},
      }),
    );
    expect(traces).toContainEqual(
      expect.objectContaining({
        type: 'tool_finished',
        toolName: 'finish_normalization',
        succeeded: true,
        result: expect.objectContaining({ details: binding }),
      }),
    );
    expect(traces.some((event) => event.type === 'assistant_message')).toBe(true);
    expect(traces.at(-1)).toMatchObject({
      type: 'agent_finished',
      agentName: 'normalization',
      turns: 1,
      toolCalls: 1,
    });
  });
});
