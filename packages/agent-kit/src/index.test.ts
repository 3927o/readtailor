import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completeJson,
  createInterviewStreamParser,
  reconstructAskAiHistory,
  reconstructReadingSetupHistory,
  runAskAiAgent,
  runNormalizationAgent,
  runReadingSetupAgent,
  type AgentTraceEvent,
  type AskAiToolbox,
  type InterviewStreamDelta,
  type NormalizationAgentToolbox,
  type NormalizationFinishBinding,
  type StrategyChangeProposal,
} from './index';

// Splits a JSON string into arbitrary chunks so the parser is exercised the way the model
// streams it — mid-string, mid-key, mid-number.
function chunk(source: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < source.length; i += size) parts.push(source.slice(i, i + size));
  return parts;
}

function drainParser(json: string, size: number, toolName = 'present_interview_question'): InterviewStreamDelta[] {
  const events: InterviewStreamDelta[] = [];
  const parser = createInterviewStreamParser((delta) => events.push(delta));
  parser.onToolStart(toolName);
  for (const part of chunk(json, size)) parser.onDelta(part);
  return events;
}

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

describe('reading setup Pi Agent', () => {
  it('can only advance the interview by submitting a host-validated tool result', async () => {
    const question = {
      id: 'goal',
      acknowledgment: '',
      prompt: '你希望从这本书里得到什么？',
      options: [
        { id: 'understand', label: '建立理解' },
        { id: 'apply', label: '实际应用' },
      ],
      allow_text: true,
      profile_dimension: 'reading_goals',
      sufficiency: 20,
    };
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'chatcmpl-reading', object: 'chat.completion.chunk', created: 0, model: 'fake-tool-model' };
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call-question',
              type: 'function',
              function: { name: 'present_interview_question', arguments: JSON.stringify(question) },
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
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const result = await runReadingSetupAgent({
      apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      sessionId: 'reading-session',
      phase: 'interviewing',
      askedCount: 0,
      context: { book: { title: 'Book' } },
      timeoutMs: 5000,
    });

    expect(result).toEqual({ type: 'question', question });
  });

  it('emits token-level interview deltas over the real streaming agent path', async () => {
    const question = {
      id: 'goal',
      acknowledgment: '好的，我明白了。',
      prompt: '你希望从这本书里得到什么？',
      options: [
        { id: 'understand', label: '建立理解' },
        { id: 'apply', label: '实际应用' },
      ],
      allow_text: true,
      profile_dimension: 'reading_goals',
      sufficiency: 40,
    };
    // Split the tool-call arguments across many small OpenAI-style streamed chunks so the
    // SDK delivers toolcall_delta events the parser must reassemble.
    const args = JSON.stringify(question);
    const fragments: string[] = [];
    for (let i = 0; i < args.length; i += 13) fragments.push(args.slice(i, i + 13));
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'chatcmpl-stream', object: 'chat.completion.chunk', created: 0, model: 'fake-tool-model' };
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{
          index: 0,
          delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-q', type: 'function', function: { name: 'present_interview_question', arguments: '' } }] },
          finish_reason: null,
        }],
      })}\n\n`);
      for (const fragment of fragments) {
        response.write(`data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: fragment } }] }, finish_reason: null }],
        })}\n\n`);
      }
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    const deltas: InterviewStreamDelta[] = [];
    const result = await runReadingSetupAgent({
      apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      sessionId: 'reading-stream-session',
      phase: 'interviewing',
      askedCount: 0,
      context: { book: { title: 'Book' } },
      timeoutMs: 5000,
      onStream: (delta) => deltas.push(delta),
    });

    expect(result).toEqual({ type: 'question', question });
    const chars = (type: InterviewStreamDelta['type']) =>
      deltas.filter((d) => d.type === type).map((d) => (d as { chars: string }).chars).join('');
    expect(chars('ack_delta')).toBe('好的，我明白了。');
    expect(chars('prompt_delta')).toBe('你希望从这本书里得到什么？');
    expect(deltas.filter((d) => d.type === 'option_added').map((d) => (d as { id: string }).id)).toEqual(['understand', 'apply']);
    expect(deltas.filter((d) => d.type === 'sufficiency').map((d) => (d as { value: number }).value).at(-1)).toBe(40);
  });
});

describe('reconstructReadingSetupHistory', () => {
  const context = {
    book: { title: 'Book' },
    bookProfile: { summary: 'bp' },
    readerProfile: { knowledge: ['k'] },
    messages: [
      { role: 'assistant', kind: 'question', content: '你想解决什么问题？' },
      { role: 'user', kind: 'answer', content: '建立整体理解' },
      { role: 'assistant', kind: 'question', content: '   ' },
      { role: 'user', kind: 'feedback', content: '注释再克制一点' },
    ],
  };
  const roleOf = (message: unknown): unknown => (message as { role?: unknown }).role;
  const contentOf = (message: unknown): unknown => (message as { content?: unknown }).content;
  const textOf = (message: unknown): string => {
    const content = contentOf(message);
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((part) => (part as { text?: unknown }).text ?? '').join('');
    }
    return '';
  };

  it('leads with a background message, then replays the transcript by persisted role', () => {
    const history = reconstructReadingSetupHistory(context, 'fake-model');

    // 4 entries (not 5): the blank-content question is dropped so it cannot desync the turn.
    expect(history.map(roleOf)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(textOf(history[0])).toContain('【长期画像与书籍资料】');
    expect(textOf(history[0])).toContain('"title": "Book"');
    // Assistant turns are plain text-content messages (no tool-call parts) and carry the model id.
    const questionTurn = history[1];
    expect(roleOf(questionTurn)).toBe('assistant');
    expect((questionTurn as { model?: string }).model).toBe('fake-model');
    expect(contentOf(questionTurn)).toEqual([{ type: 'text', text: '你想解决什么问题？' }]);
    expect(history.every((message) => textOf(message).trim().length > 0)).toBe(true);
  });

  it('appends the current draft as the trailing assistant turn on a revision turn', () => {
    const history = reconstructReadingSetupHistory(
      { ...context, currentStrategy: { version: 1, userFacingSummary: 'draft' } },
      'fake-model',
    );

    const last = history.at(-1);
    expect(roleOf(last)).toBe('assistant');
    expect(textOf(last)).toContain('【当前处理方式草稿】');
    expect(textOf(last)).toContain('"userFacingSummary": "draft"');
  });

  it('replays pre-loaded candidate node bodies as a trailing user turn on a select_trial turn', () => {
    const history = reconstructReadingSetupHistory(
      {
        ...context,
        currentStrategy: { version: 1, userFacingSummary: 'draft' },
        trialNodeContents: [
          { section_id: 'chapter-1', segment: 1, blocks: [{ block_index: 1, text: '门槛段落' }] },
        ],
      },
      'fake-model',
    );

    const last = history.at(-1);
    // The node bodies must be a user turn (host-provided data), placed after the draft.
    expect(roleOf(last)).toBe('user');
    expect(textOf(last)).toContain('【候选试读节点正文');
    expect(textOf(last)).toContain('"section_id": "chapter-1"');
    expect(textOf(history.at(-2))).toContain('【当前处理方式草稿】');
  });
});

describe('completeJson', () => {
  it('parses a complete object unchanged', () => {
    expect(completeJson('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('closes a truncated string value', () => {
    expect(completeJson('{"prompt":"你更希望从哪一')).toEqual({ prompt: '你更希望从哪一' });
  });

  it('drops a dangling key that has no value yet', () => {
    // The half-written "profile_dime… key is trimmed; the completed pair survives.
    expect(completeJson('{"prompt":"hi","profile_dime')).toEqual({ prompt: 'hi' });
  });

  it('closes a truncated array of objects', () => {
    expect(completeJson('{"options":[{"id":"a","label":"甲"},{"id":"b"')).toEqual({
      options: [{ id: 'a', label: '甲' }, { id: 'b' }],
    });
  });

  it('survives a mid-escape backslash', () => {
    expect(completeJson('{"prompt":"line\\')).toEqual({ prompt: 'line' });
  });
});

describe('createInterviewStreamParser', () => {
  const question = JSON.stringify({
    id: 'q1',
    acknowledgment: '好，我记下了。',
    prompt: '你更希望先建立整体地图，还是先深入一个具体问题？',
    hint: '这决定我先带你俯瞰，还是先钻进细节。',
    options: [
      { id: 'map', label: '先建立整体地图' },
      { id: 'deep', label: '先深入一个具体问题' },
      { id: 'mix', label: '两者结合' },
    ],
    allow_text: true,
    profile_dimension: 'reading_goals',
    sufficiency: 72,
  });

  const reassemble = (events: InterviewStreamDelta[]) => ({
    ack: events.filter((e) => e.type === 'ack_delta').map((e) => (e as { chars: string }).chars).join(''),
    prompt: events.filter((e) => e.type === 'prompt_delta').map((e) => (e as { chars: string }).chars).join(''),
    hint: events.filter((e) => e.type === 'hint_delta').map((e) => (e as { chars: string }).chars).join(''),
    options: events.filter((e) => e.type === 'option_added').map((e) => (e as { id: string }).id),
    sufficiency: events.filter((e) => e.type === 'sufficiency').map((e) => (e as { value: number }).value),
  });

  for (const size of [1, 3, 7, 500]) {
    it(`reconstructs acknowledgment, prompt, hint, every option and sufficiency at chunk size ${size}`, () => {
      const result = reassemble(drainParser(question, size));
      expect(result.ack).toBe('好，我记下了。');
      expect(result.prompt).toBe('你更希望先建立整体地图，还是先深入一个具体问题？');
      expect(result.hint).toBe('这决定我先带你俯瞰，还是先钻进细节。');
      expect(result.options).toEqual(['map', 'deep', 'mix']);
      expect(result.sufficiency.at(-1)).toBe(72);
    });
  }

  it('streams acknowledgment strictly before the prompt (field ordering is preserved)', () => {
    const events = drainParser(question, 4);
    const firstPrompt = events.findIndex((e) => e.type === 'prompt_delta');
    const lastAck = events.map((e) => e.type).lastIndexOf('ack_delta');
    expect(lastAck).toBeGreaterThanOrEqual(0);
    expect(firstPrompt).toBeGreaterThan(lastAck);
  });

  it('streams the hint after the prompt and before the first option', () => {
    const events = drainParser(question, 4);
    const lastPrompt = events.map((e) => e.type).lastIndexOf('prompt_delta');
    const firstHint = events.findIndex((e) => e.type === 'hint_delta');
    const firstOption = events.findIndex((e) => e.type === 'option_added');
    expect(firstHint).toBeGreaterThan(lastPrompt);
    expect(firstOption).toBeGreaterThan(firstHint);
  });

  it('never emits an option with a truncated label', () => {
    // Any option we surface must exactly match one from the source question.
    const labels = new Set(['先建立整体地图', '先深入一个具体问题', '两者结合']);
    const parser = createInterviewStreamParser((delta) => {
      if (delta.type === 'option_added') expect(labels.has(delta.label)).toBe(true);
    });
    parser.onToolStart('present_interview_question');
    for (const part of chunk(question, 2)) parser.onDelta(part);
  });

  it('emits a single concluding event when finish_interview is the tool call', () => {
    const events = drainParser(JSON.stringify({ book_reader_profile: {}, briefing: 'x' }), 5, 'finish_interview');
    expect(events).toEqual([{ type: 'concluding' }]);
  });

  it('infers the tool from argument keys when the tool name is absent at start', () => {
    const events: InterviewStreamDelta[] = [];
    const parser = createInterviewStreamParser((delta) => events.push(delta));
    parser.onToolStart(''); // provider withheld the name on toolcall_start
    for (const part of chunk(question, 3)) parser.onDelta(part);
    expect(reassemble(events).ack).toBe('好，我记下了。');
  });
});

// A scripted turn from the fake OpenAI-compatible model: either a single tool call or a
// streamed text answer split into content chunks. One script is consumed per HTTP request,
// so `[tool, text]` drives the real two-turn non-terminating loop (tool → answer).
type TurnScript =
  | { kind: 'tool'; name: string; arguments: string }
  | { kind: 'text'; chunks: string[] };

async function startAskAiServer(scripts: TurnScript[]): Promise<string> {
  const queue = [...scripts];
  const base = { id: 'chatcmpl-askai', object: 'chat.completion.chunk', created: 0, model: 'fake-tool-model' };
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const script = queue.shift();
    if (!script) {
      // No more scripted turns: end the stream with no delta so the agent stops.
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (script.kind === 'tool') {
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{
          index: 0,
          delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${script.name}`, type: 'function', function: { name: script.name, arguments: script.arguments } }] },
          finish_reason: null,
        }],
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    let first = true;
    for (const piece of script.chunks) {
      const delta = first ? { role: 'assistant', content: piece } : { content: piece };
      first = false;
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    }
    response.write(`data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`);
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
    });

    expect(outcome.answer).toBe('这本书的核心主题是一致性。');
    expect(deltas.join('')).toBe('这本书的核心主题是一致性。');
    expect(searched).toEqual({ query: '主题' });
    expect(outcome.turns).toBe(2);
    expect(outcome.toolCalls).toBe(1);
    expect(outcome.patchedProfile).toBe(false);
    expect(outcome.proposedStrategyChange).toBeUndefined();
  });

  it('fires onProposal and captures the proposal without terminating the answer', async () => {
    const apiBaseUrl = await startAskAiServer([
      { kind: 'tool', name: 'propose_strategy_change', arguments: JSON.stringify(sampleProposal) },
      { kind: 'text', chunks: ['我已经把调整建议提交给你确认。'] },
    ]);
    const proposals: StrategyChangeProposal[] = [];
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
      onProposal: (payload) => {
        proposals.push(payload);
      },
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toEqual(sampleProposal);
    expect(persisted).toEqual(sampleProposal);
    expect(outcome.proposedStrategyChange).toEqual(sampleProposal);
    expect(outcome.answer).toBe('我已经把调整建议提交给你确认。');
    expect(outcome.toolCalls).toBe(1);
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
