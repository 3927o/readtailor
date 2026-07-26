/** Legacy aggregate entry point for established domain Agent APIs. */

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

除了 book.normalized.html 及其资源，normalize.py 还必须在输出目录写出 metadata.json，作为这本书书目元数据的唯一来源。它是一个 JSON 对象，字段固定且全部必填：title（非空字符串）、authors（字符串数组，可为空数组）、language（非空字符串，如 zh、en）、cover_path（封面资源的相对路径如 assets/cover.jpeg，无封面填 null）、identifiers（字符串到字符串的对象，如 {"isbn":"…"}，无标识符填空对象 {}）、publisher（字符串或 null）、published_date（字符串或 null）、source_filename（源 EPUB 文件名，非空字符串）。这些值从 OPF/容器元数据提取，缺失的可空字段填 null，不得省略键。finish_normalization 会校验 metadata.json 的结构，缺失、非法 JSON 或字段不合规都会导致完成失败。

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
        '在隔离的远程沙箱中以低权限用户运行 Shell 命令来探索 EPUB。cwd=/tmp/readtailor/work，原 EPUB 位于 /tmp/readtailor/source/source.epub，解包文件位于 /tmp/readtailor/source/unpacked；source/spec/tools 只读，不得依赖或使用网络，正式执行和校验仍须使用专用工具。',
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

export const ReaderProfilePatchSchema = Type.Object({
  knowledge: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 12 })),
  remove_knowledge: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 12 }),
  ),
  explanation_preferences: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 12 }),
  ),
  remove_explanation_preferences: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 12 }),
  ),
});
export type ReaderProfilePatch = Static<typeof ReaderProfilePatchSchema>;

// The tailoring core of a reading strategy. Shared by the setup strategy (which adds
// trial_candidates for the trial phase) and the Q&A strategy-change proposal (§8.2), which
// adjusts an already-reading book and therefore has no trial phase.
const READING_STRATEGY_CORE = {
  goals: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 12 }),
  expression_principles: Type.Array(
    Type.String({ minLength: 1, maxLength: 500 }),
    { minItems: 1, maxItems: 12 },
  ),
  guide: Type.Object({
    enabled: Type.Boolean(),
    objectives: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 }),
  }),
  annotations: Type.Object({
    enabled: Type.Boolean(),
    focuses: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 }),
    exclusions: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 }),
  }),
  after_reading: Type.Object({
    enabled: Type.Boolean(),
    objectives: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 }),
  }),
};

export const ReadingStrategyCoreSchema = Type.Object(READING_STRATEGY_CORE);
export type ReadingStrategyCore = Static<typeof ReadingStrategyCoreSchema>;

// A reading-strategy change proposed by the 问 AI Agent mid-reading (§8.2). It reuses the
// setup strategy's tailoring core but omits trial_candidates. This is only ever a *proposal*:
// nothing is applied until the user confirms it through the host confirm endpoint.
export const ProposedStrategySchema = ReadingStrategyCoreSchema;
export type ProposedStrategy = Static<typeof ProposedStrategySchema>;

export const StrategyChangeProposalSchema = Type.Object({
  // The confirmation-card body shown verbatim to the user: what changes and why.
  public_summary: Type.String({ minLength: 10, maxLength: 4000 }),
  changed_fields: Type.Array(
    Type.Union([
      Type.Literal('goals'),
      Type.Literal('expressionPrinciples'),
      Type.Literal('guide'),
      Type.Literal('annotations'),
      Type.Literal('afterReading'),
    ]),
    { minItems: 1, maxItems: 5 },
  ),
  reason: Type.String({ minLength: 5, maxLength: 2000 }),
  evidence: Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { minItems: 1, maxItems: 8 }),
  strategy: ProposedStrategySchema,
});
export type StrategyChangeProposal = Static<typeof StrategyChangeProposalSchema>;

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

export type BookAnalysisAgentEvent =
  | { type: 'turn_started'; turn: number }
  | { type: 'tool_started'; toolCallId: string; toolName: string }
  | {
      type: 'tool_finished';
      toolCallId: string;
      toolName: string;
      succeeded: boolean;
    };

export async function runBookAnalysisAgent(options: {
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  toolbox: BookAnalysisToolbox;
  sessionId: string;
  maxTurns?: number;
  timeoutMs?: number;
  onEvent?: (event: BookAnalysisAgentEvent) => void | Promise<void>;
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

function userTurnMessage(text: string): AgentMessage {
  return { role: 'user', content: text, timestamp: Date.now() };
}

function assistantTurnMessage(text: string, modelName: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'readtailor-openai-compatible',
    model: modelName,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// 问 AI Agent (agent_design §8). Unlike the analysis agents above, this one is a
// conversational agent: its deliverable is the streamed answer *text*, not a
// terminating tool call. Every tool is non-terminating; the loop ends naturally
// when the model stops calling tools and emits its final answer (stopReason
// 'stop'). See docs/project/phase6_ask_ai.md for the full design.
// ---------------------------------------------------------------------------

// The host owns persistence; the toolbox is the module's only door to book content,
// reader profile and proposal storage. Read tools return text the model reads; the two
// side-effect tools return a short confirmation the model reads and keeps talking.
export interface AskAiToolbox {
  // The anchor of this question: highlighted text or current on-screen node, plus the
  // reader's current section_id + segment and position.
  getQuestionContext(signal?: AbortSignal): Promise<ToolTextResult>;
  getBookOutline(
    input: { offset?: number; limit?: number },
    signal?: AbortSignal,
  ): Promise<ToolTextResult>;
  // May resolve unread nodes — Q&A has no spoiler guard by design (§8.2).
  readBookNode(
    input: { sectionId: string; segment: number; maxCharacters?: number },
    signal?: AbortSignal,
  ): Promise<ToolTextResult>;
  searchBook(
    input: { query: string; limit?: number },
    signal?: AbortSignal,
  ): Promise<ToolTextResult>;
  // Original-book footnotes / endnotes at the given (or current) position.
  getOriginalNotes(
    input: { sectionId?: string; segment?: number },
    signal?: AbortSignal,
  ): Promise<ToolTextResult>;
  // Long-term reader profile + this book's profile + the current *confirmed* strategy.
  getReaderContext(signal?: AbortSignal): Promise<ToolTextResult>;
  // Validate/acknowledge a staged long-term profile patch; the host persists it with the answer.
  updateReaderProfile(patch: ReaderProfilePatch, signal?: AbortSignal): Promise<ToolTextResult>;
  // Stage a pending strategy-change proposal. The host persists it with the successful answer
  // before exposing a confirmation card.
  proposeStrategyChange(
    proposal: StrategyChangeProposal,
    signal?: AbortSignal,
  ): Promise<ToolTextResult>;
}

export type AskAiOutcome = {
  // The final assistant answer text (the deliverable). Non-empty on success.
  answer: string;
  // Present iff the agent called propose_strategy_change at least once this turn.
  proposedStrategyChange?: StrategyChangeProposal;
  // Union-deduped patch staged during this turn. The host persists it with the answer.
  readerProfilePatch?: ReaderProfilePatch;
  // Backward-compatible convenience flag derived from readerProfilePatch.
  patchedProfile: boolean;
  turns: number;
  toolCalls: number;
};

// Product-facing lifecycle only: callers may expose the tool name and status, but never
// receive raw arguments/results or model reasoning through this callback.
export type AskAiToolEvent =
  | { type: 'tool_started'; toolCallId: string; toolName: string }
  | {
      type: 'tool_finished';
      toolCallId: string;
      toolName: string;
      succeeded: boolean;
    };

const ASK_AI_SYSTEM_PROMPT = `你是 ReadTailor 的「问 AI」阅读助手。用户在阅读某本书时，针对划线内容或当前屏幕向你提问，你结合本书内容与用户画像给出贴合的解答，并在确有必要时更新长期画像或建议调整本书处理方式。

工作方式：
- 先用 get_question_context 了解本次提问的锚点（划线文本或当前屏幕、所在节点与位置）；再按需用 get_book_outline / read_book_node / search_book / get_original_notes 检索全书（可命中用户尚未读到的后续内容，不做防剧透限制）；用 get_reader_context 了解用户长期画像、本书画像与当前生效策略。
- 你的交付物是你直接写给用户的回答文本。想清楚后用自然语言把答案讲清楚；不再需要调用工具时，直接输出最终回答即可结束——没有专门的结束工具，也不要用工具来「宣布完成」。
- 回答必须基于书中内容与画像的真实依据，不臆造；依据不足时如实说明。

两个副作用工具都不会打断你的回答，调用后请继续把话说完：
- update_reader_profile：仅当对话暴露出关于用户长期知识背景或讲解偏好的、明确且可复用的新信息时才调用，必须有对话依据，无需用户确认。新增画像用 knowledge / explanation_preferences；用户纠正旧画像不准确时，必须用 remove_knowledge / remove_explanation_preferences 删除对应旧条目，必要时再用新增字段写入替代条目。
- propose_strategy_change：当你判断本书当前处理方式需要调整时才调用，提交面向用户的说明 public_summary 与新的结构化策略 strategy。这只是"建议"——不会立即生效，用户会看到一张确认卡，确认后宿主才创建新的正式策略；同一会话内若用户给出反馈，可再次调用修订同一建议。用户没有相关诉求、也无明显收益时，不要主动改策略。`;

function extractAssistantText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => (part as { type?: unknown }).type === 'text')
    .map((part) => {
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .join('');
}

/**
 * Rebuilds the one-per-question Q&A conversation from persisted business rows (§2.4), the
 * "warm replay as plain text" conversation; no Pi-native session is stored. `context`
 * carries: `questionContext` (the anchor for this question),
 * `messages` (prior turns of THIS question session; question=user, answer=assistant), and
 * `proposal` (the session's active proposal, if any). The *current* user question is not part
 * of the history — the host passes it as `question` and it drives the new turn via agent.prompt.
 */
export function reconstructAskAiHistory(
  context: Record<string, unknown>,
  modelName: string,
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  if (context.questionContext && typeof context.questionContext === 'object') {
    messages.push(
      userTurnMessage(`【提问上下文】\n${JSON.stringify(context.questionContext, null, 2)}`),
    );
  }
  const transcript = Array.isArray(context.messages)
    ? (context.messages as Array<{ role?: unknown; content?: unknown }>)
    : [];
  for (const entry of transcript) {
    const text = typeof entry.content === 'string'
      ? entry.content
      : JSON.stringify(entry.content ?? '');
    if (!text.trim()) continue;
    messages.push(entry.role === 'assistant'
      ? assistantTurnMessage(text, modelName)
      : userTurnMessage(text));
  }
  // Render the active proposal's *current* state as a trailing assistant turn so the agent
  // knows the fate of the suggestion it made earlier (§2.4 point 3, decision B+b): the
  // confirm/feedback endpoints only update the proposal row — this is where that update
  // becomes the "return" the agent sees next turn, without storing/mutating Pi messages.
  const proposal = context.proposal && typeof context.proposal === 'object'
    ? (context.proposal as { status?: unknown; public_summary?: unknown; feedback?: unknown })
    : undefined;
  if (proposal) {
    const summary = typeof proposal.public_summary === 'string' ? proposal.public_summary : '';
    const feedback = typeof proposal.feedback === 'string' ? proposal.feedback.trim() : '';
    let line = `我此前提出过一个处理方式调整建议（已作为待确认建议提交）：${summary}`;
    if (proposal.status === 'confirmed') {
      line += '\n用户已确认此调整，新的处理方式已生效。';
    } else if (proposal.status === 'rejected') {
      line += feedback ? `\n用户拒绝了此调整，反馈：${feedback}` : '\n用户拒绝了此调整。';
    } else if (feedback) {
      line += `\n用户尚未确认，反馈：${feedback}`;
    } else {
      line += '\n（等待用户确认。）';
    }
    messages.push(assistantTurnMessage(line, modelName));
  }
  return messages;
}

// One Pi session per HTTP request; each turn rebuilds the Q&A history from the database
// (reconstructAskAiHistory) and runs a single conversational turn, then the Agent is
// discarded (§3.3/§3.4 stateless-resume). All eight tools are non-terminating: the loop
// ends when the model emits its answer with no further tool call.
export async function runAskAiAgent(options: {
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  sessionId: string;
  question: string;
  context: Record<string, unknown>;
  toolbox: AskAiToolbox;
  maxTurns?: number;
  timeoutMs?: number;
  onAnswerDelta?: (chars: string) => void;
  onToolEvent?: (event: AskAiToolEvent) => void;
  onTrace?: AgentTraceHandler;
}): Promise<AskAiOutcome> {
  let turns = 0;
  let toolCalls = 0;
  let limitExceeded = false;
  const profileKnowledge = new Set<string>();
  const profileKnowledgeRemovals = new Set<string>();
  const profilePreferences = new Set<string>();
  const profilePreferenceRemovals = new Set<string>();
  let proposedStrategyChange: StrategyChangeProposal | undefined;
  // The final answer is the text of the last assistant message; intermediate tool-calling
  // turns rarely carry prose, but if one does we keep only the latest non-empty text.
  let lastAssistantText = '';
  let finalAssistantStopReason: 'stop' | 'length' | 'toolUse' | 'error' | 'aborted' | undefined;
  let finalAssistantErrorMessage: string | undefined;
  const maxTurns = options.maxTurns ?? 16;

  const tools: AgentTool[] = [
    {
      name: 'get_question_context',
      label: 'Get question context',
      description: '读取本次提问的锚点：划线文本或当前屏幕原文，及用户当前所在节点 section_id + segment 与位置。',
      parameters: Type.Object({}),
      execute: async (_id, _input, signal) =>
        textResult(await options.toolbox.getQuestionContext(signal)),
    },
    {
      name: 'get_book_outline',
      label: 'Get book outline',
      description: '分页读取完整 reading manifest 结构与节点列表。',
      parameters: Type.Object({
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      execute: async (_id, input, signal) =>
        textResult(
          await options.toolbox.getBookOutline(input as { offset?: number; limit?: number }, signal),
        ),
    },
    {
      name: 'read_book_node',
      label: 'Read book node',
      description: '按稳定 section id 和 segment 读取节点正文摘录，可读取用户尚未读到的后续内容。',
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
          await options.toolbox.searchBook(input as { query: string; limit?: number }, signal),
        ),
    },
    {
      name: 'get_original_notes',
      label: 'Get original notes',
      description: '读取指定位置（缺省为当前位置）的原书脚注与尾注。',
      parameters: Type.Object({
        sectionId: Type.Optional(Type.String()),
        segment: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      execute: async (_id, input, signal) =>
        textResult(
          await options.toolbox.getOriginalNotes(
            input as { sectionId?: string; segment?: number },
            signal,
          ),
        ),
    },
    {
      name: 'get_reader_context',
      label: 'Get reader context',
      description: '读取用户长期画像、本书画像与当前生效的正式处理方式。',
      parameters: Type.Object({}),
      execute: async (_id, _input, signal) =>
        textResult(await options.toolbox.getReaderContext(signal)),
    },
    {
      name: 'update_reader_profile',
      label: 'Update reader profile',
      description:
        '当对话暴露出关于用户长期知识背景或讲解偏好的、明确且可复用的新信息时，更新长期画像。新增知识背景用 knowledge，删除不准确的旧知识背景用 remove_knowledge；新增讲解偏好用 explanation_preferences，删除不准确的旧讲解偏好用 remove_explanation_preferences。必须有对话依据，无需用户确认；这不会打断你的回答。',
      parameters: ReaderProfilePatchSchema,
      executionMode: 'sequential',
      execute: async (_id, input, signal) => {
        const patch = input as ReaderProfilePatch;
        const result = await options.toolbox.updateReaderProfile(patch, signal);
        for (const item of patch.knowledge ?? []) profileKnowledge.add(item);
        for (const item of patch.remove_knowledge ?? []) profileKnowledgeRemovals.add(item);
        for (const item of patch.explanation_preferences ?? []) profilePreferences.add(item);
        for (const item of patch.remove_explanation_preferences ?? []) profilePreferenceRemovals.add(item);
        return textResult(result);
      },
    },
    {
      name: 'propose_strategy_change',
      label: 'Propose strategy change',
      description:
        '当你判断本书当前处理方式需要调整时，提交一个待用户确认的调整建议：public_summary 面向用户说明改什么、为什么；changed_fields 标出变化字段；reason 和 evidence 给出可审计依据；strategy 是完整的新结构化策略。这不会立即生效，用户会看到确认卡；同一会话可多次调用以修订同一建议。这不会打断你的回答。',
      parameters: StrategyChangeProposalSchema,
      executionMode: 'sequential',
      execute: async (_id, input, signal) => {
        const proposal = input as StrategyChangeProposal;
        const result = await options.toolbox.proposeStrategyChange(proposal, signal);
        proposedStrategyChange = proposal;
        return textResult(result);
      },
    },
  ];

  const agent = new Agent({
    initialState: {
      systemPrompt: ASK_AI_SYSTEM_PROMPT,
      model: createModel(options),
      thinkingLevel: 'medium',
      tools,
      messages: reconstructAskAiHistory(options.context, options.modelName),
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
      void options.onToolEvent?.({
        type: 'tool_started',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
    } else if (event.type === 'tool_execution_end') {
      void options.onToolEvent?.({
        type: 'tool_finished',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        succeeded: !event.isError,
      });
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      finalAssistantStopReason = event.message.stopReason;
      finalAssistantErrorMessage = event.message.errorMessage;
      const text = extractAssistantText(event.message);
      if (text.trim()) lastAssistantText = text;
    }
  });
  // Stream the answer text token-by-token (§2.5). Answer *capture* comes from message_end
  // above (robust), so a shape change in the streaming event only degrades liveness, never
  // correctness. thinking_delta is intentionally dropped.
  if (options.onAnswerDelta) {
    agent.subscribe((event) => {
      if (event.type !== 'message_update') return;
      const streamed = event.assistantMessageEvent;
      if (streamed.type === 'text_delta') options.onAnswerDelta!(streamed.delta);
    });
  }
  subscribeAgentTrace(agent, {
    agentName: 'ask_ai',
    sessionId: options.sessionId,
    modelName: options.modelName,
    systemPrompt: ASK_AI_SYSTEM_PROMPT,
    prompt: options.question,
    getTurn: () => turns,
    getToolCalls: () => toolCalls,
    ...(options.onTrace ? { onTrace: options.onTrace } : {}),
  });
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, timeoutMs);
  try {
    await agent.prompt(options.question);
  } finally {
    clearTimeout(timeout);
  }

  if (finalAssistantStopReason === 'error' || finalAssistantStopReason === 'aborted') {
    if (limitExceeded) throw new Error(`ask ai agent exceeded the ${maxTurns}-turn limit`);
    if (timedOut) throw new Error(`ask ai agent timed out after ${timeoutMs}ms`);
    const detail = finalAssistantErrorMessage?.trim();
    throw new Error(
      detail
        ? `ask ai agent stopped with ${finalAssistantStopReason}: ${detail}`
        : `ask ai agent stopped with ${finalAssistantStopReason}`,
    );
  }
  const answer = lastAssistantText.trim();
  if (!answer) {
    if (limitExceeded) throw new Error(`ask ai agent exceeded the ${maxTurns}-turn limit`);
    throw new Error('ask ai agent stopped without producing an answer');
  }
  const readerProfilePatch: ReaderProfilePatch | undefined =
    profileKnowledge.size > 0
      || profileKnowledgeRemovals.size > 0
      || profilePreferences.size > 0
      || profilePreferenceRemovals.size > 0
      ? {
          ...(profileKnowledge.size > 0 ? { knowledge: [...profileKnowledge] } : {}),
          ...(profileKnowledgeRemovals.size > 0
            ? { remove_knowledge: [...profileKnowledgeRemovals] }
            : {}),
          ...(profilePreferences.size > 0
            ? { explanation_preferences: [...profilePreferences] }
            : {}),
          ...(profilePreferenceRemovals.size > 0
            ? { remove_explanation_preferences: [...profilePreferenceRemovals] }
            : {}),
        }
      : undefined;
  return {
    answer,
    ...(proposedStrategyChange ? { proposedStrategyChange } : {}),
    ...(readerProfilePatch ? { readerProfilePatch } : {}),
    patchedProfile: readerProfilePatch !== undefined,
    turns,
    toolCalls,
  };
}
