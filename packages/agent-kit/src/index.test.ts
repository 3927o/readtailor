import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  reconstructAskAiHistory,
  runAskAiAgent,
  runNormalizationAgent,
  type AgentTraceEvent,
  type AskAiToolbox,
  type NormalizationAgentToolbox,
  type NormalizationFinishBinding,
  type StrategyChangeProposal,
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

// A scripted turn from the fake OpenAI-compatible model: either a single tool call or a
// streamed text answer split into content chunks. One script is consumed per HTTP request.
type TurnScript =
  | { kind: 'tool'; name: string; arguments: string; text?: string }
  | { kind: 'text'; chunks: string[]; finishReason?: string }
  | { kind: 'hang'; chunks: string[] };

async function startAskAiServer(
  scripts: TurnScript[],
  onTools?: (toolNames: string[]) => void,
): Promise<string> {
  const queue = [...scripts];
  const base = {
    id: 'chatcmpl-askai',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake-tool-model',
  };
  const server = createServer(async (request, response) => {
    if (onTools) {
      let body = '';
      for await (const part of request) body += String(part);
      const payload = JSON.parse(body) as {
        tools?: Array<{ name?: string; function?: { name?: string } }>;
      };
      onTools((payload.tools ?? []).flatMap((tool) => {
        const name = tool.name ?? tool.function?.name;
        return name ? [name] : [];
      }));
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    const script = queue.shift();
    if (!script) {
      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
      return;
    }
    if (script.kind === 'tool') {
      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{
            index: 0,
            delta: {
              role: 'assistant',
              ...(script.text ? { content: script.text } : {}),
              tool_calls: [{
                index: 0,
                id: `call-${script.name}`,
                type: 'function',
                function: { name: script.name, arguments: script.arguments },
              }],
            },
            finish_reason: null,
          }],
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
      return;
    }
    let first = true;
    for (const piece of script.chunks) {
      const delta = first ? { role: 'assistant', content: piece } : { content: piece };
      first = false;
      response.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta, finish_reason: null }],
        })}\n\n`,
      );
    }
    if (script.kind === 'hang') return;
    response.write(
      `data: ${JSON.stringify({
        ...base,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: script.finishReason ?? 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`,
    );
    response.end('data: [DONE]\n\n');
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}/v1`;
}

function stubAskAiToolbox(overrides: Partial<AskAiToolbox> = {}): AskAiToolbox {
  const unavailable = async () => {
    throw new Error('unexpected tool call');
  };
  return {
    getQuestionContext: async () => ({ text: '划线：某段原文' }),
    getBookOutline: unavailable,
    readBookNode: unavailable,
    searchBook: unavailable,
    getOriginalNotes: unavailable,
    getReaderContext: unavailable,
    updateReaderProfile: unavailable,
    proposeStrategyChange: unavailable,
    ...overrides,
  };
}

const sampleProposal: StrategyChangeProposal = {
  public_summary: '建议在概念密集处增加更细致的解释，并放宽注释克制度。',
  changed_fields: ['annotations'],
  reason: '用户明确希望关键术语得到更充分的解释。',
  evidence: ['能不能多解释一点？'],
  strategy: {
    goals: ['在关键概念处加强解释，降低理解门槛'],
    expression_principles: ['保持原文完整，仅在确有理解价值处补充'],
    guide: { enabled: true, objectives: ['开始前交代当前位置与重点'] },
    annotations: { enabled: true, focuses: ['解释关键概念与背景'], exclusions: ['不复述已清楚的原文'] },
    after_reading: { enabled: false, objectives: [] },
  },
};

describe('runAskAiAgent', () => {
  it('runs the non-terminating loop: a read tool, then a final streamed answer', async () => {
    const apiBaseUrl = await startAskAiServer([
      { kind: 'tool', name: 'search_book', arguments: JSON.stringify({ query: '主题' }) },
      { kind: 'text', chunks: ['这本书的', '核心主题是', '一致性。'] },
    ]);
    const deltas: string[] = [];
    const toolEvents: unknown[] = [];
    let searched: unknown;
    const outcome = await runAskAiAgent({
      apiBaseUrl,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      sessionId: 'qa-search',
      question: '这本书讲什么？',
      context: {},
      toolbox: stubAskAiToolbox({
        searchBook: async (input) => {
          searched = input;
          return { text: '命中：主题相关段落' };
        },
      }),
      timeoutMs: 5000,
      onAnswerDelta: (chars) => deltas.push(chars),
      onToolEvent: (event) => toolEvents.push(event),
    });

    expect(outcome.answer).toBe('这本书的核心主题是一致性。');
    expect(deltas.join('')).toBe('这本书的核心主题是一致性。');
    expect(searched).toEqual({ query: '主题' });
    expect(outcome.turns).toBe(2);
    expect(outcome.toolCalls).toBe(1);
    expect(toolEvents).toEqual([
      {
        type: 'tool_started',
        toolCallId: 'call-search_book',
        toolName: 'search_book',
      },
      {
        type: 'tool_finished',
        toolCallId: 'call-search_book',
        toolName: 'search_book',
        succeeded: true,
      },
    ]);
    expect(toolEvents.every((event) => (
      !('args' in (event as Record<string, unknown>))
      && !('result' in (event as Record<string, unknown>))
    ))).toBe(true);
    expect(outcome.patchedProfile).toBe(false);
    expect(outcome.proposedStrategyChange).toBeUndefined();
  });

  it('stages a proposal without terminating the answer', async () => {
    const apiBaseUrl = await startAskAiServer([
      { kind: 'tool', name: 'propose_strategy_change', arguments: JSON.stringify(sampleProposal) },
      { kind: 'text', chunks: ['我已经把调整建议提交给你确认。'] },
    ]);
    let persisted: unknown;
    const outcome = await runAskAiAgent({
      apiBaseUrl,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      sessionId: 'qa-proposal',
      question: '能不能多解释一点？',
      context: {},
      toolbox: stubAskAiToolbox({
        proposeStrategyChange: async (proposal) => {
          persisted = proposal;
          return { text: '已提交，等待用户确认。' };
        },
      }),
      timeoutMs: 5000,
    });

    expect(persisted).toEqual(sampleProposal);
    expect(outcome.proposedStrategyChange).toEqual(sampleProposal);
    expect(outcome.answer).toBe('我已经把调整建议提交给你确认。');
    expect(outcome.toolCalls).toBe(1);
  });

  it('union-dedupes profile patches in memory until the answer succeeds', async () => {
    const apiBaseUrl = await startAskAiServer([
      {
        kind: 'tool',
        name: 'update_reader_profile',
        arguments: JSON.stringify({ knowledge: ['类型系统'], explanation_preferences: ['先举例'] }),
      },
      {
        kind: 'tool',
        name: 'update_reader_profile',
        arguments: JSON.stringify({
          knowledge: ['类型系统', '编译器'],
          remove_knowledge: ['计算机与互联网'],
          remove_explanation_preferences: ['多补互联网背景'],
        }),
      },
      { kind: 'text', chunks: ['我会按这个背景继续解释。'] },
    ]);
    const acknowledged: unknown[] = [];
    const outcome = await runAskAiAgent({
      apiBaseUrl,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      sessionId: 'qa-profile',
      question: '我熟悉类型系统，请先举例。',
      context: {},
      toolbox: stubAskAiToolbox({
        updateReaderProfile: async (patch) => {
          acknowledged.push(patch);
          return { text: '已暂存。' };
        },
      }),
      timeoutMs: 5000,
    });

    expect(acknowledged).toHaveLength(2);
    expect(outcome.readerProfilePatch).toEqual({
      knowledge: ['类型系统', '编译器'],
      remove_knowledge: ['计算机与互联网'],
      explanation_preferences: ['先举例'],
      remove_explanation_preferences: ['多补互联网背景'],
    });
    expect(outcome.patchedProfile).toBe(true);
  });

  it('answers directly in one turn when no tool is needed', async () => {
    const apiBaseUrl = await startAskAiServer([
      { kind: 'text', chunks: ['这是一个直接回答。'] },
    ]);
    const outcome = await runAskAiAgent({
      apiBaseUrl,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      sessionId: 'qa-direct',
      question: '你好',
      context: {},
      toolbox: stubAskAiToolbox(),
      timeoutMs: 5000,
    });

    expect(outcome.answer).toBe('这是一个直接回答。');
    expect(outcome.turns).toBe(1);
    expect(outcome.toolCalls).toBe(0);
  });

  it('rejects a final provider error despite staged changes and text from earlier turns', async () => {
    const apiBaseUrl = await startAskAiServer([
      {
        kind: 'tool',
        name: 'update_reader_profile',
        arguments: JSON.stringify({ knowledge: ['类型系统'] }),
        text: '我先记下你的背景。',
      },
      {
        kind: 'tool',
        name: 'propose_strategy_change',
        arguments: JSON.stringify(sampleProposal),
        text: '我也准备了一份调整建议。',
      },
      { kind: 'text', chunks: ['这段最终回答尚未完成'], finishReason: 'network_error' },
    ]);
    const staged: string[] = [];

    const result = runAskAiAgent({
      apiBaseUrl,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      sessionId: 'qa-provider-error',
      question: '请按我的背景调整解释。',
      context: {},
      toolbox: stubAskAiToolbox({
        updateReaderProfile: async () => {
          staged.push('profile');
          return { text: '已暂存画像。' };
        },
        proposeStrategyChange: async () => {
          staged.push('proposal');
          return { text: '已暂存建议。' };
        },
      }),
      timeoutMs: 5000,
    });

    await expect(result).rejects.toThrow(/network_error/);
    expect(staged).toEqual(['profile', 'proposal']);
  });

  it('rejects an aborted final turn on timeout despite partial and earlier tool-turn text', async () => {
    const apiBaseUrl = await startAskAiServer([
      {
        kind: 'tool',
        name: 'update_reader_profile',
        arguments: JSON.stringify({ explanation_preferences: ['先举例'] }),
        text: '我会先举例说明。',
      },
      { kind: 'hang', chunks: ['这是尚未完成的最终回答'] },
    ]);

    const result = runAskAiAgent({
      apiBaseUrl,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      sessionId: 'qa-timeout',
      question: '请继续。',
      context: {},
      toolbox: stubAskAiToolbox({
        updateReaderProfile: async () => ({ text: '已暂存画像。' }),
      }),
      timeoutMs: 30,
    });

    await expect(result).rejects.toThrow('ask ai agent timed out after 30ms');
  });
});

describe('reconstructAskAiHistory', () => {
  const roleOf = (message: unknown): unknown => (message as { role?: unknown }).role;
  const textOf = (message: unknown): string => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (part as { text?: unknown }).text ?? '').join('');
    return '';
  };

  it('leads with the question context, replays prior turns, and appends a pending proposal', () => {
    const history = reconstructAskAiHistory(
      {
        questionContext: { mode: 'highlight', text: '某段原文', sectionId: 'ch1', segment: 2 },
        messages: [
          { role: 'user', content: '这段什么意思？' },
          { role: 'assistant', content: '这段是说……' },
          { role: 'assistant', content: '   ' },
        ],
        proposal: { status: 'pending', public_summary: '建议增加更细的解释' },
      },
      'fake-model',
    );

    // The blank assistant turn is dropped so it can't desync the reconstruction.
    expect(history.map(roleOf)).toEqual(['user', 'user', 'assistant', 'assistant']);
    expect(textOf(history[0])).toContain('【提问上下文】');
    expect(textOf(history[0])).toContain('"sectionId": "ch1"');
    expect((history[2] as { model?: string }).model).toBe('fake-model');
    const proposalTurn = history.at(-1);
    expect(roleOf(proposalTurn)).toBe('assistant');
    expect(textOf(proposalTurn)).toContain('建议增加更细的解释');
    expect(textOf(proposalTurn)).toContain('等待用户确认');
  });

  it('renders a confirmed proposal and a feedback proposal distinctly', () => {
    const confirmed = reconstructAskAiHistory(
      { proposal: { status: 'confirmed', public_summary: '放宽注释克制度' } },
      'fake-model',
    );
    expect(textOf(confirmed.at(-1))).toContain('用户已确认此调整');

    const withFeedback = reconstructAskAiHistory(
      { proposal: { status: 'pending', public_summary: '放宽注释克制度', feedback: '再克制一点' } },
      'fake-model',
    );
    expect(textOf(withFeedback.at(-1))).toContain('反馈：再克制一点');
  });

  it('returns an empty history when there is no context', () => {
    expect(reconstructAskAiHistory({}, 'fake-model')).toEqual([]);
  });
});
/** Verifies retained Agent Kit normalization, book analysis, and Ask AI behavior. */
