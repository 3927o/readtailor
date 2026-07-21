import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completeJson,
  createReadingSetupStreamParser,
  reconstructAskAiHistory,
  reconstructReadingSetupHistory,
  runAskAiAgent,
  runNormalizationAgent,
  runReadingSetupAgent,
  type AgentTraceEvent,
  type AskAiToolbox,
  type CompletionSnapshot,
  type InterviewCompletionStore,
  type NormalizationAgentToolbox,
  type NormalizationFinishBinding,
  type ReadingSetupStreamDelta,
  type StrategyChangeProposal,
} from './index';

// Splits a JSON string into arbitrary chunks so the parser is exercised the way the model
// streams it — mid-string, mid-key, mid-number.
function chunk(source: string, size: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < source.length; i += size) parts.push(source.slice(i, i + size));
  return parts;
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

function createMemoryCompletionStore(
  initial: CompletionSnapshot = { completionId: null, baseConversationVersion: null },
) {
  let snapshot = structuredClone(initial);
  const calls: string[] = [];
  const store: InterviewCompletionStore = {
    async load() {
      calls.push('load');
      return structuredClone(snapshot);
    },
    async start() {
      calls.push('start');
      if (!snapshot.completionId) {
        snapshot = { ...snapshot, completionId: 'completion-1', baseConversationVersion: 2 };
      }
      return structuredClone(snapshot);
    },
    async submitBriefing(value) {
      calls.push('briefing');
      snapshot = { ...snapshot, briefing: value };
      return structuredClone(snapshot);
    },
    async submitStrategy(value) {
      calls.push('strategy');
      snapshot = { ...snapshot, strategy: value };
      return structuredClone(snapshot);
    },
    async submitCandidates(value) {
      calls.push('candidates');
      snapshot = { ...snapshot, candidates: value };
      return structuredClone(snapshot);
    },
    async submitProfile(value) {
      calls.push('profile');
      snapshot = { ...snapshot, profile: value };
      return structuredClone(snapshot);
    },
    async complete() {
      calls.push('complete');
      if (!snapshot.briefing || !snapshot.strategy || !snapshot.candidates || !snapshot.profile) {
        throw new Error('incomplete fixture');
      }
      return {
        briefing: snapshot.briefing,
        strategy: snapshot.strategy,
        candidates: snapshot.candidates,
        profile: snapshot.profile,
      };
    },
  };
  return { store, calls, snapshot: () => structuredClone(snapshot) };
}

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

    const setupDeltas: ReadingSetupStreamDelta[] = [];
    const result = await runReadingSetupAgent({
      apiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      sessionId: 'reading-stream-session',
      phase: 'interviewing',
      askedCount: 0,
      context: { book: { title: 'Book' } },
      timeoutMs: 5000,
      onReadingSetupStream: (delta) => setupDeltas.push(delta),
    });

    expect(result).toEqual({ type: 'question', question });
    const chars = (type: 'ack_delta' | 'prompt_delta' | 'hint_delta') =>
      setupDeltas.map((delta) => delta.type === type ? delta.chars : '').join('');
    expect(chars('ack_delta')).toBe('好的，我明白了。');
    expect(chars('prompt_delta')).toBe('你希望从这本书里得到什么？');
    expect(setupDeltas.filter((delta) => delta.type === 'option_added').map((delta) => delta.id)).toEqual(['understand', 'apply']);
    expect(setupDeltas.filter((delta) => delta.type === 'sufficiency').map((delta) => delta.value).at(-1)).toBe(40);
    expect(setupDeltas[0]).toEqual({
      type: 'speculative_reset',
      speculativeEpoch: 1,
      toolName: 'present_interview_question',
    });
    expect(setupDeltas.filter((delta) => delta.type === 'prompt_delta').every((delta) => delta.speculativeEpoch === 1)).toBe(true);
  });

  it('persists completion artifacts through ordered tools and returns the legacy completed outcome', async () => {
    const briefing = {
      book_identity: '这是一本帮助读者建立复杂系统整体认识的书。',
      arc: '全书从局部现象出发，逐步建立系统结构与动态关系。',
      assumed_knowledge: '默认读者了解基础概念，但不要求具备专业建模经验。',
      reading_advice: '先抓住各章之间的因果主线，再回头处理公式和细节。',
    };
    const publicStrategy = '先帮助读者建立全书结构，再解释真正阻碍理解的关键概念；保留原文推进节奏，只在必要位置增加定位、背景和回顾。';
    const strategy = {
      goals: ['建立整体理解'],
      expression_principles: ['保持克制，只补充影响理解的信息'],
      guide: { enabled: true, objectives: ['说明章节位置与阅读重点'] },
      annotations: { enabled: true, focuses: ['关键概念'], exclusions: ['不复述清晰原文'] },
      after_reading: { enabled: true, objectives: ['回顾核心关系'] },
    };
    const candidates = [
      { section_id: 'chapter-1', segment: 1, reason: '覆盖进入本书时的理解门槛。' },
      { section_id: 'chapter-2', segment: 1, reason: '覆盖全书最典型的论证内容。' },
      { section_id: 'chapter-3', segment: 1, reason: '覆盖关系复杂且难度较高的内容。' },
    ];
    const profile = {
      book_reader_profile: {
        summary: '读者希望建立整体框架，并在关键概念处获得克制而准确的帮助。',
        motivations: ['理解复杂系统'],
        prior_knowledge: ['了解基础概念'],
        reading_goals: ['建立整体框架'],
        likely_barriers: ['容易迷失在局部细节中'],
      },
      reader_profile_patch: { knowledge: ['复杂系统基础概念'] },
    };
    const apiBaseUrl = await startAskAiServer([
      { kind: 'tool', name: 'finish_interview', arguments: '{}' },
      { kind: 'tool', name: 'submit_reading_briefing', arguments: JSON.stringify(briefing) },
      {
        kind: 'tool',
        name: 'submit_reading_strategy',
        arguments: JSON.stringify({ public_strategy: publicStrategy, strategy }),
      },
      { kind: 'tool', name: 'submit_trial_candidates', arguments: JSON.stringify({ candidates }) },
      { kind: 'tool', name: 'submit_interview_profile', arguments: JSON.stringify(profile) },
      { kind: 'tool', name: 'complete_interview_result', arguments: '{}' },
    ]);
    const completion = createMemoryCompletionStore();
    const deltas: ReadingSetupStreamDelta[] = [];

    const result = await runReadingSetupAgent({
      apiBaseUrl,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      sessionId: 'completion-session',
      phase: 'interviewing',
      askedCount: 1,
      context: { book: { title: 'Book' } },
      completionStore: completion.store,
      timeoutMs: 5000,
      onReadingSetupStream: (delta) => deltas.push(delta),
    });

    expect(completion.calls).toEqual([
      'load',
      'start',
      'briefing',
      'strategy',
      'candidates',
      'profile',
      'complete',
    ]);
    expect(result).toEqual({
      type: 'completed',
      bookReaderProfile: profile.book_reader_profile,
      readerProfilePatch: profile.reader_profile_patch,
      briefing,
      publicStrategy,
      strategy: { ...strategy, trial_candidates: candidates },
    });
    expect(deltas.filter((delta) => delta.type === 'speculative_reset')).toHaveLength(1);
    expect(deltas.filter((delta) => delta.type === 'draft_started')).toEqual([
      { type: 'draft_started', source: 'interview', speculativeEpoch: 1 },
    ]);
  });

  it('resumes at the first missing completion artifact without exposing another question', async () => {
    const briefing = {
      book_identity: '这是一本帮助读者建立复杂系统整体认识的书。',
      arc: '全书从局部现象出发，逐步建立系统结构与动态关系。',
      assumed_knowledge: '默认读者了解基础概念，但不要求具备专业建模经验。',
      reading_advice: '先抓住各章之间的因果主线，再回头处理公式和细节。',
    };
    const strategy = {
      publicStrategy: '先建立结构，再解释真正阻碍理解的关键概念；尽量保持原文节奏，并在必要位置加入简短定位和回顾。',
      strategy: {
        goals: ['建立整体理解'],
        expression_principles: ['保持克制'],
        guide: { enabled: true, objectives: ['定位'] },
        annotations: { enabled: true, focuses: ['概念'], exclusions: [] },
        after_reading: { enabled: true, objectives: ['回顾'] },
      },
    };
    const candidates = [
      { section_id: 'chapter-1', segment: 1, reason: '覆盖进入本书时的理解门槛。' },
      { section_id: 'chapter-2', segment: 1, reason: '覆盖全书最典型的论证内容。' },
      { section_id: 'chapter-3', segment: 1, reason: '覆盖关系复杂且难度较高的内容。' },
    ];
    const profile = {
      book_reader_profile: {
        summary: '读者希望建立整体框架，并在关键概念处获得克制而准确的帮助。',
        motivations: ['理解复杂系统'],
        prior_knowledge: [],
        reading_goals: ['建立整体框架'],
        likely_barriers: ['局部细节过多'],
      },
    };
    let offeredTools: string[] = [];
    const apiBaseUrl = await startAskAiServer([
      { kind: 'tool', name: 'submit_interview_profile', arguments: JSON.stringify(profile) },
      { kind: 'tool', name: 'complete_interview_result', arguments: '{}' },
    ], (tools) => {
      offeredTools = tools;
    });
    const completion = createMemoryCompletionStore({
      completionId: 'completion-1',
      baseConversationVersion: 2,
      briefing,
      strategy,
      candidates,
    });

    const result = await runReadingSetupAgent({
      apiBaseUrl,
      apiKey: 'test-key',
      modelName: 'fake-tool-model',
      sessionId: 'completion-resume-session',
      phase: 'interviewing',
      askedCount: 3,
      context: { book: { title: 'Book' } },
      completionStore: completion.store,
      timeoutMs: 5000,
    });

    expect(completion.calls).toEqual(['load', 'profile', 'complete']);
    expect(offeredTools).not.toContain('present_interview_question');
    expect(result.type).toBe('completed');
  });

  it('lets select_trial choose block boundaries without model-calculated offsets', async () => {
    const fragments = [
      {
        sectionId: 'chapter-1',
        segment: 1,
        tag: 'threshold' as const,
        range: { start: { blockIndex: 1 }, end: { blockIndex: 2 } },
        reason: '覆盖进入本书时的理解门槛。',
      },
      {
        sectionId: 'chapter-2',
        segment: 1,
        tag: 'typical' as const,
        range: { start: { blockIndex: 3 }, end: { blockIndex: 5 } },
        reason: '覆盖全书典型内容的表达方式。',
      },
      {
        sectionId: 'chapter-3',
        segment: 1,
        tag: 'hardest' as const,
        range: { start: { blockIndex: 2 }, end: { blockIndex: 4 } },
        reason: '覆盖较高难度内容的处理效果。',
      },
    ];
    let selectTool: unknown;
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const part of request) body += String(part);
      const payload = JSON.parse(body) as { tools?: unknown[] };
      selectTool = payload.tools?.find((tool) => {
        const value = tool as { name?: unknown; function?: { name?: unknown } };
        return value.name === 'select_trial_fragments'
          || value.function?.name === 'select_trial_fragments';
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'chatcmpl-select-trial', object: 'chat.completion.chunk', created: 0, model: 'fake-tool-model' };
      response.write(`data: ${JSON.stringify({
        ...base,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call-select-trial',
              type: 'function',
              function: { name: 'select_trial_fragments', arguments: JSON.stringify({ fragments }) },
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
      sessionId: 'select-trial-session',
      phase: 'select_trial',
      askedCount: 0,
      context: {
        book: { title: 'Book' },
        trialNodeContents: fragments.map((fragment) => ({
          sectionId: fragment.sectionId,
          segment: fragment.segment,
          blocks: Array.from(
            { length: fragment.range.end.blockIndex },
            (_value, index) => ({ blockIndex: index + 1, text: `正文 ${index + 1}` }),
          ),
        })),
      },
      timeoutMs: 5000,
    });

    expect(result).toEqual({ type: 'fragments', fragments });
    expect(selectTool).toBeDefined();
    const serializedTool = JSON.stringify(selectTool);
    expect(serializedTool).toContain('sectionId');
    expect(serializedTool).toContain('blockIndex');
    expect(serializedTool).not.toContain('section_id');
    expect(serializedTool).not.toContain('block_index');
    expect(serializedTool).not.toMatch(/"offset"\s*:/);
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
          { sectionId: 'chapter-1', segment: 1, blocks: [{ blockIndex: 1, text: '门槛段落' }] },
        ],
      },
      'fake-model',
    );

    const last = history.at(-1);
    // The node bodies must be a user turn (host-provided data), placed after the draft.
    expect(roleOf(last)).toBe('user');
    expect(textOf(last)).toContain('【候选试读节点正文');
    expect(textOf(last)).toContain('"sectionId": "chapter-1"');
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

describe('createReadingSetupStreamParser', () => {
  const candidates = [
    { section_id: 'chapter-1', segment: 1, reason: '用于观察进入门槛。' },
    { section_id: 'chapter-2', segment: 2, reason: '典型内容含有括号（以及“引号”）。' },
    { section_id: 'chapter-3', segment: 3, reason: '较难内容包含反斜杠 \\ 和右花括号 }。' },
  ];
  const briefing = {
    book_identity: '这是一本讨论复杂系统的书。',
    arc: '全书从局部问题逐步走向整体结构。',
    assumed_knowledge: '默认读者知道基础概念。',
    reading_advice: '先抓住论证主线，再处理细节。',
  };
  const strategy = {
    public_strategy: '先建立结构，再只解释真正阻碍理解的概念。',
    strategy: {
      goals: ['理解主线'],
      expression_principles: ['保持克制'],
      guide: { enabled: true, objectives: ['定位'] },
      annotations: { enabled: true, focuses: ['概念'], exclusions: [] },
      after_reading: { enabled: true, objectives: ['回顾'] },
    },
  };

  const fragments = [
    {
      sectionId: 'chapter-1',
      segment: 1,
      tag: 'threshold',
      range: { start: { blockIndex: 1 }, end: { blockIndex: 12 } },
      reason: '覆盖进入本书时的理解门槛。',
    },
    {
      sectionId: 'chapter-2',
      segment: 2,
      tag: 'typical',
      range: { start: { blockIndex: 3 }, end: { blockIndex: 5 } },
      reason: '覆盖典型内容，并保留“关键”例子。',
    },
    {
      sectionId: 'chapter-3',
      segment: 3,
      tag: 'hardest',
      range: { start: { blockIndex: 6 }, end: { blockIndex: 8 } },
      reason: '覆盖较难内容与嵌套关系 {A\\B}。',
    },
  ] as const;

  for (const size of [1, 2, 7, 10_000]) {
    it(`streams completion tools in one epoch at chunk size ${size}`, () => {
      const events: ReadingSetupStreamDelta[] = [];
      const parser = createReadingSetupStreamParser((delta) => events.push(delta));
      parser.onToolStart('finish_interview');
      parser.onDelta('{}');
      parser.onToolSucceeded('finish_interview');
      parser.onToolStart('submit_reading_briefing');
      for (const part of chunk(JSON.stringify(briefing), size)) parser.onDelta(part);
      parser.acceptCompletion({
        completionId: 'completion-1',
        baseConversationVersion: 2,
        briefing,
      });
      parser.onToolStart('submit_reading_strategy');
      for (const part of chunk(JSON.stringify(strategy), size)) parser.onDelta(part);
      parser.acceptCompletion({
        completionId: 'completion-1',
        baseConversationVersion: 2,
        briefing,
        strategy: { publicStrategy: strategy.public_strategy, strategy: strategy.strategy },
      });
      parser.onToolStart('submit_trial_candidates');
      for (const part of chunk(JSON.stringify({ candidates }), size)) parser.onDelta(part);

      expect(events.filter((event) => event.type === 'speculative_reset')).toEqual([{
        type: 'speculative_reset',
        speculativeEpoch: 1,
        toolName: 'finish_interview',
      }]);
      expect(events[1]).toEqual({ type: 'draft_started', source: 'interview', speculativeEpoch: 1 });
      const streamedBriefing = Object.fromEntries(
        ['book_identity', 'arc', 'assumed_knowledge', 'reading_advice'].map((field) => [
          field,
          events
            .filter((event) => event.type === 'briefing_delta' && event.field === field)
            .map((event) => event.type === 'briefing_delta' ? event.chars : '')
            .join(''),
        ]),
      );
      expect(streamedBriefing).toEqual(briefing);
      expect(events.filter((event) => event.type === 'strategy_delta').map((event) => event.type === 'strategy_delta' ? event.chars : '').join(''))
        .toBe('先建立结构，再只解释真正阻碍理解的概念。');
      expect(events.filter((event) => event.type === 'reading_node_added')).toEqual(
        candidates.map((candidate, index) => ({
          type: 'reading_node_added',
          speculativeEpoch: 1,
          ordinal: index + 1,
          sectionId: candidate.section_id,
          segment: candidate.segment,
          reason: candidate.reason,
        })),
      );
    });
  }

  it('does not reset streamed state during normal completion stage transitions', () => {
    const events: ReadingSetupStreamDelta[] = [];
    const parser = createReadingSetupStreamParser((delta) => events.push(delta));
    parser.onToolStart('finish_interview');
    parser.onToolSucceeded('finish_interview');
    parser.onToolStart('submit_reading_briefing');
    parser.onDelta(JSON.stringify(briefing));
    parser.acceptCompletion({
      completionId: 'completion-1',
      baseConversationVersion: 2,
      briefing,
    });
    parser.onToolStart('submit_reading_strategy');
    parser.onDelta(JSON.stringify(strategy));
    parser.acceptCompletion({
      completionId: 'completion-1',
      baseConversationVersion: 2,
      briefing,
      strategy: { publicStrategy: strategy.public_strategy, strategy: strategy.strategy },
    });
    parser.onToolStart('submit_trial_candidates');
    parser.onDelta(JSON.stringify({ candidates }));

    expect(events.filter((event) => event.type === 'speculative_reset')).toHaveLength(1);
    const visibleTypes = events
      .filter((event) => event.type === 'briefing_delta' || event.type === 'strategy_delta' || event.type === 'reading_node_added')
      .map((event) => event.type);
    expect(visibleTypes.findIndex((type) => type === 'strategy_delta'))
      .toBeGreaterThan(visibleTypes.findLastIndex((type) => type === 'briefing_delta'));
    expect(visibleTypes.findIndex((type) => type === 'reading_node_added'))
      .toBeGreaterThan(visibleTypes.findLastIndex((type) => type === 'strategy_delta'));
  });

  it('starts a new epoch when the current completion stage is retried', () => {
    const events: ReadingSetupStreamDelta[] = [];
    const parser = createReadingSetupStreamParser((delta) => events.push(delta));
    parser.replayCompletion({
      completionId: 'completion-1',
      baseConversationVersion: 2,
      briefing,
    });
    parser.onToolStart('submit_reading_strategy');
    parser.onDelta('{"public_strategy":"第一版尚未完成');
    parser.onToolStart('submit_reading_strategy');
    parser.onDelta(JSON.stringify(strategy));

    expect(events.filter((event) => event.type === 'speculative_reset')).toEqual([
      { type: 'speculative_reset', speculativeEpoch: 1, toolName: null },
      { type: 'speculative_reset', speculativeEpoch: 2, toolName: 'submit_reading_strategy' },
    ]);
    expect(events.filter((event) => event.type === 'strategy_delta' && event.speculativeEpoch === 2)
      .map((event) => event.type === 'strategy_delta' ? event.chars : '').join(''))
      .toBe(strategy.public_strategy);
  });

  it('replays only accepted completion checkpoints on resume and retry', () => {
    const events: ReadingSetupStreamDelta[] = [];
    const parser = createReadingSetupStreamParser((delta) => events.push(delta));
    const snapshot: CompletionSnapshot = {
      completionId: 'completion-1',
      baseConversationVersion: 4,
      briefing,
      strategy: { publicStrategy: strategy.public_strategy, strategy: strategy.strategy },
      candidates,
    };

    parser.replayCompletion(snapshot);
    parser.onToolStart('submit_interview_profile');
    parser.onDelta('{"book_reader_profile":{"summary":"尚未持久化的画像');
    parser.onToolStart('submit_interview_profile');

    expect(events.filter((event) => event.type === 'speculative_reset')).toEqual([
      { type: 'speculative_reset', speculativeEpoch: 1, toolName: null },
      { type: 'speculative_reset', speculativeEpoch: 2, toolName: 'submit_interview_profile' },
    ]);
    for (const epoch of [1, 2]) {
      expect(events.filter((event) => event.type === 'briefing_delta' && event.speculativeEpoch === epoch)
        .map((event) => event.type === 'briefing_delta' ? event.chars : '').join(''))
        .toBe(Object.values(briefing).join(''));
      expect(events.filter((event) => event.type === 'strategy_delta' && event.speculativeEpoch === epoch)
        .map((event) => event.type === 'strategy_delta' ? event.chars : '').join(''))
        .toBe(strategy.public_strategy);
      expect(events.filter((event) => event.type === 'reading_node_added' && event.speculativeEpoch === epoch))
        .toHaveLength(3);
    }
  });

  it('resets and suppresses a different stage after the current stage was not accepted', () => {
    const events: ReadingSetupStreamDelta[] = [];
    const parser = createReadingSetupStreamParser((delta) => events.push(delta));
    parser.replayCompletion({
      completionId: 'completion-1',
      baseConversationVersion: 2,
      briefing,
    });
    parser.onToolStart('submit_reading_strategy');
    parser.onDelta('{"public_strategy":"尚未持久化的策略');
    parser.onToolStart('submit_trial_candidates');
    parser.onDelta(JSON.stringify({ candidates }));

    expect(events.filter((event) => event.type === 'speculative_reset')).toEqual([
      { type: 'speculative_reset', speculativeEpoch: 1, toolName: null },
      { type: 'speculative_reset', speculativeEpoch: 2, toolName: 'submit_trial_candidates' },
    ]);
    expect(events.some((event) => (
      event.type === 'reading_node_added' && event.speculativeEpoch === 2
    ))).toBe(false);
    expect(events.filter((event) => (
      event.type === 'briefing_delta' && event.speculativeEpoch === 2
    ))).toHaveLength(4);
  });

  it('never emits a candidate before its real closing brace arrives', () => {
    const source = JSON.stringify({ candidates });
    const events: ReadingSetupStreamDelta[] = [];
    const parser = createReadingSetupStreamParser((delta) => events.push(delta));
    parser.replayCompletion({
      completionId: 'completion-1',
      baseConversationVersion: 2,
      briefing,
      strategy: { publicStrategy: strategy.public_strategy, strategy: strategy.strategy },
    });
    parser.onToolStart('submit_trial_candidates');
    const marker = source.indexOf('用于观察进入门槛。') + '用于观察进入门槛。'.length;
    parser.onDelta(source.slice(0, marker));
    expect(events.some((event) => event.type === 'reading_node_added')).toBe(false);
    parser.onDelta(source.slice(marker));
    expect(events.filter((event) => event.type === 'reading_node_added')).toHaveLength(3);
  });

  for (const size of [1, 3, 11, 10_000]) {
    it(`emits each complete fragment once at chunk size ${size}`, () => {
      const events: ReadingSetupStreamDelta[] = [];
      const parser = createReadingSetupStreamParser((delta) => events.push(delta));
      parser.onToolStart('select_trial_fragments');
      for (const part of chunk(JSON.stringify({ fragments }), size)) parser.onDelta(part);
      expect(events.slice(0, 2)).toEqual([
        { type: 'speculative_reset', speculativeEpoch: 1, toolName: 'select_trial_fragments' },
        { type: 'selection_started', speculativeEpoch: 1, total: 3 },
      ]);
      expect(events.filter((event) => event.type === 'fragment_added')).toEqual(
        fragments.map((fragment, index) => ({
          type: 'fragment_added',
          speculativeEpoch: 1,
          ordinal: index + 1,
          fragment,
        })),
      );
    });
  }

  it('does not accept a fragment whose numeric blockIndex may still grow', () => {
    const source = JSON.stringify({ fragments });
    const events: ReadingSetupStreamDelta[] = [];
    const parser = createReadingSetupStreamParser((delta) => events.push(delta));
    parser.onToolStart('select_trial_fragments');
    const blockIndex = source.indexOf('12');
    parser.onDelta(source.slice(0, blockIndex + 1));
    expect(events.some((event) => event.type === 'fragment_added')).toBe(false);
    parser.onDelta(source.slice(blockIndex + 1));
    expect(events.filter((event) => event.type === 'fragment_added')).toHaveLength(3);
  });

  it('does not accept the legacy snake_case fragment shape', () => {
    const events: ReadingSetupStreamDelta[] = [];
    const parser = createReadingSetupStreamParser((delta) => events.push(delta));
    parser.onToolStart('select_trial_fragments');
    parser.onDelta(JSON.stringify({
      fragments: [{
        section_id: 'chapter-1',
        segment: 1,
        tag: 'threshold',
        range: { start: { block_index: 1 }, end: { block_index: 2 } },
        reason: '覆盖进入本书时的理解门槛。',
      }],
    }));
    expect(events.some((event) => event.type === 'fragment_added')).toBe(false);
  });

  it('increments speculativeEpoch and resets streamed state for a replacement tool call', () => {
    const events: ReadingSetupStreamDelta[] = [];
    const parser = createReadingSetupStreamParser((delta) => events.push(delta));
    parser.onToolStart('save_strategy_draft');
    parser.onDelta('{"public_strategy":"第一版尚未通过');
    parser.onToolStart('save_strategy_draft');
    parser.onDelta(JSON.stringify({ public_strategy: '第二版完整内容', strategy: { trial_candidates: candidates } }));

    expect(events.filter((event) => event.type === 'speculative_reset')).toEqual([
      { type: 'speculative_reset', speculativeEpoch: 1, toolName: 'save_strategy_draft' },
      { type: 'speculative_reset', speculativeEpoch: 2, toolName: 'save_strategy_draft' },
    ]);
    expect(events.filter((event) => event.type === 'draft_started')).toEqual([
      { type: 'draft_started', source: 'revision', speculativeEpoch: 1 },
      { type: 'draft_started', source: 'revision', speculativeEpoch: 2 },
    ]);
    expect(events.filter((event) => event.type === 'strategy_delta' && event.speculativeEpoch === 2)
      .map((event) => event.type === 'strategy_delta' ? event.chars : '').join('')).toBe('第二版完整内容');
  });

  it('infers the briefing tool when the provider initially withholds its name', () => {
    const events: ReadingSetupStreamDelta[] = [];
    const parser = createReadingSetupStreamParser((delta) => events.push(delta));
    parser.replayCompletion({ completionId: 'completion-1', baseConversationVersion: 2 });
    parser.onToolStart('');
    for (const part of chunk(JSON.stringify(briefing), 5)) parser.onDelta(part);
    expect(events[0]).toEqual({ type: 'speculative_reset', speculativeEpoch: 1, toolName: null });
    expect(events.some((event) => event.type === 'draft_started' && event.source === 'interview')).toBe(true);
    expect(events.some((event) => event.type === 'briefing_delta')).toBe(true);
  });

  it('does not expose completion UI for a submit tool called before finish_interview succeeds', () => {
    const events: ReadingSetupStreamDelta[] = [];
    const parser = createReadingSetupStreamParser((delta) => events.push(delta));
    parser.onToolStart('submit_reading_briefing');
    parser.onDelta(JSON.stringify(briefing));

    expect(events.some((event) => event.type === 'draft_started')).toBe(false);
    expect(events.some((event) => event.type === 'briefing_delta')).toBe(false);
  });

  it('emits persisted artifacts after sequential execution of batched tool calls', () => {
    const events: ReadingSetupStreamDelta[] = [];
    const parser = createReadingSetupStreamParser((delta) => events.push(delta));
    parser.onToolStart('finish_interview');
    parser.onDelta('{}');
    parser.onToolStart('submit_reading_briefing');
    parser.onDelta(JSON.stringify(briefing));
    parser.onToolStart('submit_reading_strategy');
    parser.onDelta(JSON.stringify(strategy));
    parser.onToolStart('submit_trial_candidates');
    parser.onDelta(JSON.stringify({ candidates }));

    expect(events.some((event) => event.type === 'draft_started')).toBe(false);
    expect(events.some((event) => event.type === 'briefing_delta')).toBe(false);
    parser.acceptCompletion({ completionId: 'completion-1', baseConversationVersion: 2 });
    parser.acceptCompletion({
      completionId: 'completion-1',
      baseConversationVersion: 2,
      briefing,
    });
    parser.acceptCompletion({
      completionId: 'completion-1',
      baseConversationVersion: 2,
      briefing,
      strategy: { publicStrategy: strategy.public_strategy, strategy: strategy.strategy },
    });
    parser.acceptCompletion({
      completionId: 'completion-1',
      baseConversationVersion: 2,
      briefing,
      strategy: { publicStrategy: strategy.public_strategy, strategy: strategy.strategy },
      candidates,
    });

    expect(events.filter((event) => event.type === 'draft_started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'briefing_delta')).toHaveLength(4);
    expect(events.filter((event) => event.type === 'strategy_delta')
      .map((event) => event.type === 'strategy_delta' ? event.chars : '').join(''))
      .toBe(strategy.public_strategy);
    expect(events.filter((event) => event.type === 'reading_node_added')).toHaveLength(3);
  });

  it('uses the current phase when an unnamed strategy tool is ambiguous', () => {
    const events: ReadingSetupStreamDelta[] = [];
    const parser = createReadingSetupStreamParser(
      (delta) => events.push(delta),
      'strategy_review',
    );
    parser.onToolStart('');
    parser.onDelta(JSON.stringify(strategy));

    expect(events[0]).toEqual({ type: 'speculative_reset', speculativeEpoch: 1, toolName: null });
    expect(events).toContainEqual({
      type: 'draft_started',
      source: 'revision',
      speculativeEpoch: 1,
    });
    expect(events.some((event) => event.type === 'strategy_delta')).toBe(true);
  });
});

// A scripted turn from the fake OpenAI-compatible model: either a single tool call or a
// streamed text answer split into content chunks. One script is consumed per HTTP request,
// so `[tool, text]` drives the real two-turn non-terminating loop (tool → answer).
type TurnScript =
  | { kind: 'tool'; name: string; arguments: string; text?: string }
  | { kind: 'text'; chunks: string[]; finishReason?: string }
  | { kind: 'hang'; chunks: string[] };

async function startAskAiServer(
  scripts: TurnScript[],
  onTools?: (toolNames: string[]) => void,
): Promise<string> {
  const queue = [...scripts];
  const base = { id: 'chatcmpl-askai', object: 'chat.completion.chunk', created: 0, model: 'fake-tool-model' };
  const server = createServer(async (request, response) => {
    if (onTools) {
      let body = '';
      for await (const part of request) body += String(part);
      const payload = JSON.parse(body) as { tools?: Array<{ name?: string; function?: { name?: string } }> };
      onTools((payload.tools ?? []).flatMap((tool) => {
        const name = tool.name ?? tool.function?.name;
        return name ? [name] : [];
      }));
    }
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
          delta: {
            role: 'assistant',
            ...(script.text ? { content: script.text } : {}),
            tool_calls: [{ index: 0, id: `call-${script.name}`, type: 'function', function: { name: script.name, arguments: script.arguments } }],
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
      return;
    }
    let first = true;
    for (const piece of script.chunks) {
      const delta = first ? { role: 'assistant', content: piece } : { content: piece };
      first = false;
      response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    }
    if (script.kind === 'hang') return;
    response.write(`data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: script.finishReason ?? 'stop' }],
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
