import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
} from '@earendil-works/pi-agent-core';
import { Type, type Model, type Static } from '@earendil-works/pi-ai';

export type NormalizationFinishBinding = {
  sourceEpubSha256: string;
  scriptSha256: string;
  outputInventorySha256: string;
  validatorVersion: string;
  validationReportSha256: string;
  blockingErrorCount: number;
  warningCount: number;
};

export type ToolTextResult = {
  text: string;
  details?: Record<string, unknown>;
};

export type AgentTraceEvent =
  | {
      type: 'agent_started';
      agentName: string;
      sessionId: string;
      modelName: string;
      systemPrompt: string;
      prompt: string;
    }
  | { type: 'turn_started'; agentName: string; turn: number }
  | {
      type: 'assistant_message';
      agentName: string;
      turn: number;
      message: unknown;
    }
  | {
      type: 'tool_started';
      agentName: string;
      turn: number;
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: 'tool_finished';
      agentName: string;
      turn: number;
      toolCallId: string;
      toolName: string;
      succeeded: boolean;
      durationMs: number;
      result: unknown;
    }
  | {
      type: 'turn_finished';
      agentName: string;
      turn: number;
      toolResultCount: number;
    }
  | {
      type: 'agent_finished';
      agentName: string;
      turns: number;
      toolCalls: number;
      messageCount: number;
    };

export type AgentTraceHandler = (event: AgentTraceEvent) => void | Promise<void>;

const TRACE_STRING_LIMIT = 8_000;
const TRACE_COLLECTION_LIMIT = 50;

function traceString(value: string): string {
  if (value.length <= TRACE_STRING_LIMIT) return value;
  return `${value.slice(0, TRACE_STRING_LIMIT)}\n... trace truncated (${value.length - TRACE_STRING_LIMIT} characters omitted) ...`;
}

function traceValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return traceString(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value !== 'object') return String(value);
  if (value instanceof Uint8Array) return { type: 'Uint8Array', byteLength: value.byteLength };
  if (seen.has(value)) return '[circular]';
  if (depth >= 5) return '[depth limit]';
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value
      .slice(0, TRACE_COLLECTION_LIMIT)
      .map((item) => traceValue(item, depth + 1, seen));
    if (value.length > TRACE_COLLECTION_LIMIT) {
      items.push(`[${value.length - TRACE_COLLECTION_LIMIT} items omitted]`);
    }
    return items;
  }
  const entries = Object.entries(value).slice(0, TRACE_COLLECTION_LIMIT);
  const result = Object.fromEntries(
    entries.map(([key, item]) => [key, traceValue(item, depth + 1, seen)]),
  );
  if (Object.keys(value).length > TRACE_COLLECTION_LIMIT) {
    result.__trace_omitted_keys__ = Object.keys(value).length - TRACE_COLLECTION_LIMIT;
  }
  return result;
}

function traceMessage(message: AgentMessage): unknown {
  if (message.role !== 'assistant') return traceValue(message);
  return {
    role: message.role,
    content: traceValue(message.content),
    model: message.model,
    responseModel: message.responseModel,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    usage: traceValue(message.usage),
  };
}

function subscribeAgentTrace(
  agent: Agent,
  options: {
    agentName: string;
    sessionId: string;
    modelName: string;
    systemPrompt: string;
    prompt: string;
    getTurn: () => number;
    getToolCalls: () => number;
    onTrace?: AgentTraceHandler;
  },
): void {
  const toolStartedAt = new Map<string, number>();
  agent.subscribe(async (event) => {
    if (!options.onTrace) return;
    let trace: AgentTraceEvent | undefined;
    if (event.type === 'agent_start') {
      trace = {
        type: 'agent_started',
        agentName: options.agentName,
        sessionId: options.sessionId,
        modelName: options.modelName,
        systemPrompt: options.systemPrompt,
        prompt: options.prompt,
      };
    } else if (event.type === 'turn_start') {
      trace = { type: 'turn_started', agentName: options.agentName, turn: options.getTurn() };
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      trace = {
        type: 'assistant_message',
        agentName: options.agentName,
        turn: options.getTurn(),
        message: traceMessage(event.message),
      };
    } else if (event.type === 'tool_execution_start') {
      toolStartedAt.set(event.toolCallId, Date.now());
      trace = {
        type: 'tool_started',
        agentName: options.agentName,
        turn: options.getTurn(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: traceValue(event.args),
      };
    } else if (event.type === 'tool_execution_end') {
      const startedAt = toolStartedAt.get(event.toolCallId);
      toolStartedAt.delete(event.toolCallId);
      trace = {
        type: 'tool_finished',
        agentName: options.agentName,
        turn: options.getTurn(),
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        succeeded: !event.isError,
        durationMs: startedAt ? Date.now() - startedAt : 0,
        result: traceValue(event.result),
      };
    } else if (event.type === 'turn_end') {
      trace = {
        type: 'turn_finished',
        agentName: options.agentName,
        turn: options.getTurn(),
        toolResultCount: event.toolResults.length,
      };
    } else if (event.type === 'agent_end') {
      trace = {
        type: 'agent_finished',
        agentName: options.agentName,
        turns: options.getTurn(),
        toolCalls: options.getToolCalls(),
        messageCount: event.messages.length,
      };
    }
    if (trace) {
      try {
        await options.onTrace(trace);
      } catch {
        // Trace logging must not change agent behavior.
      }
    }
  });
}

export interface NormalizationAgentToolbox {
  runShell(
    input: { command: string; timeoutSeconds?: number },
    signal?: AbortSignal,
  ): Promise<ToolTextResult>;
  inspectEpubStructure(signal?: AbortSignal): Promise<ToolTextResult>;
  writeNormalizer(input: { content: string }, signal?: AbortSignal): Promise<ToolTextResult>;
  patchNormalizer(
    input: { expected: string; replacement: string },
    signal?: AbortSignal,
  ): Promise<ToolTextResult>;
  runNormalizer(signal?: AbortSignal): Promise<ToolTextResult>;
  runNbLinter(signal?: AbortSignal): Promise<ToolTextResult>;
  runNbCheck(signal?: AbortSignal): Promise<ToolTextResult>;
  finishNormalization(signal?: AbortSignal): Promise<NormalizationFinishBinding>;
}

export type NormalizationAgentEvent =
  | { type: 'turn_started'; turn: number }
  | { type: 'tool_started'; toolCallId: string; toolName: string }
  | {
      type: 'tool_finished';
      toolCallId: string;
      toolName: string;
      succeeded: boolean;
    };

export type NormalizationAgentOptions = {
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  toolbox: NormalizationAgentToolbox;
  sessionId: string;
  maxTurns?: number;
  timeoutMs?: number;
  onEvent?: (event: NormalizationAgentEvent) => void | Promise<void>;
  onTrace?: AgentTraceHandler;
};

export type NormalizationAgentResult = {
  finishBinding: NormalizationFinishBinding;
  turns: number;
  toolCalls: number;
};

const NORMALIZATION_SYSTEM_PROMPT = `你是 ReadTailor 的 EPUB 规范化 Coding Agent。

你的唯一目标是编写 normalize.py，把当前 source.epub 转换成符合 nb-1.0 的书籍包。你只能使用给定工具；Shell 命令必须通过 run_shell 执行，不能联网、不能修改校验器或规范。

第一步必须调用 inspect_epub_structure，先获得容器、OPF、manifest、spine、导航、资源和异常的全局视图。之后只对异常项和少量代表性文件使用 run_shell 深入检查；不要重复做全量目录扫描。可用路径：原 EPUB=/tmp/readtailor/source/source.epub，解包目录=/tmp/readtailor/source/unpacked，规范=/tmp/readtailor/spec/normalized_book_spec.md，当前输出=/tmp/readtailor/output/current。

工作闭环：inspect_epub_structure -> 必要的定点检查 -> 编写或修补 normalize.py -> run_normalizer -> run_nb_linter -> run_nb_check -> 根据问题修复。Shell 仅用于探索，不能替代受信任的 normalizer、校验和完成工具。run_nb_linter 通过后立即运行 run_nb_check；run_nb_check 的 blocking error 为 0 后立即调用 finish_normalization，warning 只作为诊断信息、不阻断完成。只有 finish_normalization 成功才算任务完成，不得用文字自行宣布完成。

必须保留无法可靠分类的原文和资源，不能通过删除内容换取校验通过。每次修改脚本后必须重新运行 normalizer 和完整校验。`;

const NORMALIZATION_INITIAL_PROMPT =
  '开始处理当前 EPUB。第一步调用 inspect_epub_structure，然后只对异常和代表性文件做定点检查，尽快编写 normalize.py。必须通过完整校验并调用 finish_normalization。';

function textResult(result: ToolTextResult) {
  return {
    content: [{ type: 'text' as const, text: result.text }],
    details: result.details ?? {},
  };
}

function createTools(
  toolbox: NormalizationAgentToolbox,
  onFinish: (binding: NormalizationFinishBinding) => void,
): AgentTool[] {
  return [
    {
      name: 'run_shell',
      label: 'Run exploration shell',
      description:
        '在隔离的 E2B 中以低权限用户运行 Shell 命令来探索 EPUB。cwd=/tmp/readtailor/work，原 EPUB 位于 /tmp/readtailor/source/source.epub，解包文件位于 /tmp/readtailor/source/unpacked；source/spec/tools 只读且网络不可用，正式执行和校验仍须使用专用工具。',
      parameters: Type.Object({
        command: Type.String({ minLength: 1, maxLength: 20_000 }),
        timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
      }),
      executionMode: 'sequential',
      execute: async (_id, input, signal) =>
        textResult(
          await toolbox.runShell(
            input as { command: string; timeoutSeconds?: number },
            signal,
          ),
        ),
    },
    {
      name: 'inspect_epub_structure',
      label: 'Inspect EPUB structure',
      description:
        '可信地解析源 EPUB，一次返回 container/OPF metadata、manifest 分类、spine 顺序和正文统计、nav/NCX/guide、资源汇总、特殊结构及缺失引用等异常。每个任务必须先调用一次。',
      parameters: Type.Object({}),
      execute: async (_id, _input, signal) =>
        textResult(await toolbox.inspectEpubStructure(signal)),
    },
    {
      name: 'write_normalizer',
      label: 'Write normalizer',
      description: '创建或完整替换 normalize.py；这是唯一可写的代码文件。',
      parameters: Type.Object({ content: Type.String({ minLength: 1, maxLength: 500_000 }) }),
      executionMode: 'sequential',
      execute: async (_id, input, signal) =>
        textResult(await toolbox.writeNormalizer(input as { content: string }, signal)),
    },
    {
      name: 'patch_normalizer',
      label: 'Patch normalizer',
      description: '把 normalize.py 中唯一匹配的 expected 文本替换为 replacement。',
      parameters: Type.Object({
        expected: Type.String({ minLength: 1, maxLength: 200_000 }),
        replacement: Type.String({ maxLength: 200_000 }),
      }),
      executionMode: 'sequential',
      execute: async (_id, input, signal) =>
        textResult(
          await toolbox.patchNormalizer(
            input as { expected: string; replacement: string },
            signal,
          ),
        ),
    },
    {
      name: 'run_normalizer',
      label: 'Run normalizer',
      description: '清空旧输出后，以固定参数执行当前 normalize.py。',
      parameters: Type.Object({}),
      executionMode: 'sequential',
      execute: async (_id, _input, signal) => textResult(await toolbox.runNormalizer(signal)),
    },
    {
      name: 'run_nb_linter',
      label: 'Run nb linter',
      description: '对当前输出运行结构校验。',
      parameters: Type.Object({}),
      executionMode: 'sequential',
      execute: async (_id, _input, signal) => textResult(await toolbox.runNbLinter(signal)),
    },
    {
      name: 'run_nb_check',
      label: 'Run nb check',
      description: '以源 EPUB 为 baseline 对当前输出运行完整确定性校验。',
      parameters: Type.Object({}),
      executionMode: 'sequential',
      execute: async (_id, _input, signal) => textResult(await toolbox.runNbCheck(signal)),
    },
    {
      name: 'finish_normalization',
      label: 'Finish normalization',
      description: '核对最新脚本、输出和完整校验的哈希绑定；不满足时会失败。',
      parameters: Type.Object({}),
      executionMode: 'sequential',
      execute: async (_id, _input, signal) => {
        const binding = await toolbox.finishNormalization(signal);
        onFinish(binding);
        return {
          content: [{ type: 'text' as const, text: 'Normalization accepted by the attempt gate.' }],
          details: binding,
          terminate: true,
        };
      },
    },
  ];
}

function createModel(options: {
  apiBaseUrl: string;
  modelName: string;
}): Model<'openai-completions'> {
  return {
    id: options.modelName,
    name: options.modelName,
    api: 'openai-completions',
    provider: 'readtailor-openai-compatible',
    baseUrl: options.apiBaseUrl.replace(/\/+$/, ''),
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

export async function runNormalizationAgent(
  options: NormalizationAgentOptions,
): Promise<NormalizationAgentResult> {
  const maxTurns = options.maxTurns ?? 50;
  const timeoutMs = options.timeoutMs ?? 30 * 60_000;
  let finishBinding: NormalizationFinishBinding | undefined;
  let turns = 0;
  let toolCalls = 0;
  let limitExceeded = false;

  const agent = new Agent({
    initialState: {
      systemPrompt: NORMALIZATION_SYSTEM_PROMPT,
      model: createModel(options),
      thinkingLevel: 'medium',
      tools: createTools(options.toolbox, (binding) => {
        finishBinding = binding;
      }),
      messages: [],
    },
    sessionId: options.sessionId,
    getApiKey: () => options.apiKey,
    toolExecution: 'sequential',
  });

  agent.subscribe(async (event: AgentEvent) => {
    if (event.type === 'turn_start') {
      if (turns >= maxTurns) {
        limitExceeded = true;
        agent.abort();
        return;
      }
      turns += 1;
      await options.onEvent?.({ type: 'turn_started', turn: turns });
    } else if (event.type === 'tool_execution_start') {
      toolCalls += 1;
      await options.onEvent?.({
        type: 'tool_started',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    } else if (event.type === 'tool_execution_end') {
      await options.onEvent?.({
        type: 'tool_finished',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        succeeded: !event.isError,
      });
    }
  });
  subscribeAgentTrace(agent, {
    agentName: 'normalization',
    sessionId: options.sessionId,
    modelName: options.modelName,
    systemPrompt: NORMALIZATION_SYSTEM_PROMPT,
    prompt: NORMALIZATION_INITIAL_PROMPT,
    getTurn: () => turns,
    getToolCalls: () => toolCalls,
    ...(options.onTrace ? { onTrace: options.onTrace } : {}),
  });

  const timeout = setTimeout(() => agent.abort(), timeoutMs);
  try {
    await agent.prompt(NORMALIZATION_INITIAL_PROMPT);
  } finally {
    clearTimeout(timeout);
  }

  if (!finishBinding) {
    if (limitExceeded) {
      throw new Error(`normalization agent exceeded the ${maxTurns}-turn limit`);
    }
    throw new Error('normalization agent stopped without a successful finish_normalization call');
  }

  return { finishBinding, turns, toolCalls };
}

export const BookProfileSchema = Type.Object({
  version: Type.Literal('book-profile-1.0'),
  summary: Type.String({ minLength: 20, maxLength: 3000 }),
  structure: Type.String({ minLength: 20, maxLength: 3000 }),
  core_questions: Type.Array(Type.String({ minLength: 5, maxLength: 500 }), {
    minItems: 1,
    maxItems: 12,
  }),
  themes: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
    minItems: 1,
    maxItems: 20,
  }),
  reading_barriers: Type.Array(Type.String({ minLength: 5, maxLength: 500 }), {
    minItems: 1,
    maxItems: 12,
  }),
  reading_advice: Type.Array(Type.String({ minLength: 5, maxLength: 500 }), {
    minItems: 1,
    maxItems: 12,
  }),
  trial_candidates: Type.Array(
    Type.Object({
      section_id: Type.String({ minLength: 1, maxLength: 200 }),
      segment: Type.Integer({ minimum: 1 }),
      features: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
        minItems: 1,
        maxItems: 8,
      }),
      reason: Type.String({ minLength: 5, maxLength: 500 }),
    }),
    { minItems: 1, maxItems: 15 },
  ),
});
export type BookProfile = Static<typeof BookProfileSchema>;

export interface BookAnalysisToolbox {
  getBookMetadata(signal?: AbortSignal): Promise<ToolTextResult>;
  getBookOutline(
    input: { offset?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<ToolTextResult>;
  readBookNode(
    input: { sectionId: string; segment: number; maxCharacters?: number },
    signal?: AbortSignal,
  ): Promise<ToolTextResult>;
  searchBook(
    input: { query: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<ToolTextResult>;
  getNodeStats(
    input: { sectionId: string; segment: number },
    signal?: AbortSignal,
  ): Promise<ToolTextResult>;
  saveBookProfile(profile: BookProfile, signal?: AbortSignal): Promise<void>;
}

const BOOK_ANALYSIS_SYSTEM_PROMPT = `你是 ReadTailor 的共享书籍分析 Agent。只读已经通过确定性校验的规范化书籍和 reading manifest，生成不含任何用户信息的 book-profile-1.0。先检查元数据和完整结构，再抽样阅读开头、中段、后段以及具有代表性的节点。试读候选只能引用 tailoring_eligible=true 的节点，覆盖全书不同位置。不要修改原文，不要复制大段原文。只有 save_book_profile 成功才算完成。`;

const BOOK_ANALYSIS_INITIAL_PROMPT =
  '分析当前书籍并生成共享 book profile。候选池通常为 9–15 个；若全书可裁读节点不足 9 个，则使用全部可裁读节点。';

export async function runBookAnalysisAgent(options: {
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  toolbox: BookAnalysisToolbox;
  sessionId: string;
  maxTurns?: number;
  timeoutMs?: number;
  onTrace?: AgentTraceHandler;
}): Promise<{ profile: BookProfile; turns: number; toolCalls: number }> {
  let profile: BookProfile | undefined;
  let turns = 0;
  let toolCalls = 0;
  let limitExceeded = false;
  const maxTurns = options.maxTurns ?? 20;
  const tools: AgentTool[] = [
    {
      name: 'get_book_metadata',
      label: 'Get book metadata',
      description: '读取书籍元数据和全书机械统计。',
      parameters: Type.Object({}),
      execute: async (_id, _input, signal) =>
        textResult(await options.toolbox.getBookMetadata(signal)),
    },
    {
      name: 'get_book_outline',
      label: 'Get book outline',
      description: '分页读取完整 reading manifest 结构和可裁读节点。',
      parameters: Type.Object({
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      execute: async (_id, input, signal) =>
        textResult(
          await options.toolbox.getBookOutline(
            input as { offset?: number; limit?: number },
            signal,
          ),
        ),
    },
    {
      name: 'read_book_node',
      label: 'Read book node',
      description: '按稳定 section id 和 segment 读取节点正文摘录。',
      parameters: Type.Object({
        sectionId: Type.String(),
        segment: Type.Integer({ minimum: 1 }),
        maxCharacters: Type.Optional(Type.Integer({ minimum: 500, maximum: 12000 })),
      }),
      execute: async (_id, input, signal) =>
        textResult(
          await options.toolbox.readBookNode(
            input as { sectionId: string; segment: number; maxCharacters?: number },
            signal,
          ),
        ),
    },
    {
      name: 'search_book',
      label: 'Search book',
      description: '在规范化全书中搜索关键词并返回短上下文。',
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 200 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      }),
      execute: async (_id, input, signal) =>
        textResult(
          await options.toolbox.searchBook(
            input as { query: string; limit?: number },
            signal,
          ),
        ),
    },
    {
      name: 'get_node_stats',
      label: 'Get node stats',
      description: '读取指定节点的字符、图片、注释等机械统计。',
      parameters: Type.Object({
        sectionId: Type.String(),
        segment: Type.Integer({ minimum: 1 }),
      }),
      execute: async (_id, input, signal) =>
        textResult(
          await options.toolbox.getNodeStats(
            input as { sectionId: string; segment: number },
            signal,
          ),
        ),
    },
    {
      name: 'save_book_profile',
      label: 'Save book profile',
      description: '提交最终共享书籍画像；宿主会验证候选节点和裁读资格。',
      parameters: BookProfileSchema,
      executionMode: 'sequential',
      execute: async (_id, input, signal) => {
        const candidate = input as BookProfile;
        await options.toolbox.saveBookProfile(candidate, signal);
        profile = candidate;
        return {
          content: [{ type: 'text' as const, text: 'Book profile accepted.' }],
          details: { candidateCount: candidate.trial_candidates.length },
          terminate: true,
        };
      },
    },
  ];

  const agent = new Agent({
    initialState: {
      systemPrompt: BOOK_ANALYSIS_SYSTEM_PROMPT,
      model: createModel(options),
      thinkingLevel: 'medium',
      tools,
      messages: [],
    },
    sessionId: options.sessionId,
    getApiKey: () => options.apiKey,
    toolExecution: 'sequential',
  });
  agent.subscribe((event) => {
    if (event.type === 'turn_start') {
      if (turns >= maxTurns) {
        limitExceeded = true;
        agent.abort();
        return;
      }
      turns += 1;
    } else if (event.type === 'tool_execution_start') {
      toolCalls += 1;
    }
  });
  subscribeAgentTrace(agent, {
    agentName: 'book_analysis',
    sessionId: options.sessionId,
    modelName: options.modelName,
    systemPrompt: BOOK_ANALYSIS_SYSTEM_PROMPT,
    prompt: BOOK_ANALYSIS_INITIAL_PROMPT,
    getTurn: () => turns,
    getToolCalls: () => toolCalls,
    ...(options.onTrace ? { onTrace: options.onTrace } : {}),
  });
  const timeout = setTimeout(() => agent.abort(), options.timeoutMs ?? 20 * 60_000);
  try {
    await agent.prompt(BOOK_ANALYSIS_INITIAL_PROMPT);
  } finally {
    clearTimeout(timeout);
  }
  if (!profile) {
    if (limitExceeded) throw new Error(`book analysis agent exceeded the ${maxTurns}-turn limit`);
    throw new Error('book analysis agent stopped without saving a valid profile');
  }
  return { profile, turns, toolCalls };
}
