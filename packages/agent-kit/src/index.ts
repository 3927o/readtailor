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

export const InterviewQuestionSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  // Field order matters for token-level streaming (§3.3): acknowledgment first (逐字致谢),
  // then prompt (逐字问题), options (逐个弹出), and sufficiency last (末充足度). The
  // acknowledgment answers the previous turn and is an empty string on the first question.
  // These maxLengths are guardrails against a runaway turn, not the target register — the
  // system prompt asks for a much terser conversation (ack ≤30, prompt ≤40, hint ≤40, option
  // label ≤15 字). The caps sit well above those targets so a concise turn never trips
  // validation (which would force a costly retry), while still capping a verbose one that
  // would look bad in the chat UI.
  acknowledgment: Type.String({ maxLength: 120 }),
  prompt: Type.String({ minLength: 5, maxLength: 400 }),
  // A one-line rationale shown under the question ("why I'm asking this"), matching the
  // prototype's per-question hint. Optional so legacy/streamed-partial questions stay valid;
  // the system prompt asks the agent to always supply it. Not token-streamed — it settles in
  // with the authoritative question_final frame.
  hint: Type.Optional(Type.String({ maxLength: 150 })),
  options: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 100 }),
      label: Type.String({ minLength: 1, maxLength: 80 }),
    }),
    { minItems: 2, maxItems: 5 },
  ),
  allow_text: Type.Literal(true),
  profile_dimension: Type.String({ minLength: 1, maxLength: 200 }),
  sufficiency: Type.Integer({ minimum: 0, maximum: 100 }),
});
export type InterviewQuestion = Static<typeof InterviewQuestionSchema>;

// Closes the open strings/arrays/objects of a truncated JSON buffer so it parses. Returns
// undefined when the prefix is unbalanced (more closers than openers).
function closeJsonStructures(src: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() === undefined) return undefined;
    }
  }
  let out = src;
  if (inString) {
    if (escaped) out = out.slice(0, -1); // drop a dangling backslash mid-escape
    out += '"';
  }
  out = out.replace(/\s+$/, '');
  const last = out[out.length - 1];
  if (last === ',') out = out.slice(0, -1).replace(/\s+$/, '');
  else if (last === ':') out += 'null'; // key awaiting a value
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i];
  return out;
}

// Best-effort parse of a possibly-truncated JSON string. Tries the buffer as-is, then
// closes open structures; if that still fails (e.g. a half-written key with no colon yet)
// it trims a bounded tail and retries so a complete prefix still parses.
export function completeJson(src: string): unknown {
  if (!src.trim()) return undefined;
  const maxTrim = Math.min(src.length, 64);
  for (let cut = 0; cut <= maxTrim; cut++) {
    const closed = closeJsonStructures(src.slice(0, src.length - cut));
    if (closed === undefined) continue;
    try {
      return JSON.parse(closed);
    } catch {
      // keep trimming
    }
  }
  return undefined;
}

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

export const BookReaderProfileSchema = Type.Object({
  summary: Type.String({ minLength: 20, maxLength: 3000 }),
  motivations: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 12 }),
  prior_knowledge: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 12 }),
  reading_goals: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 12 }),
  likely_barriers: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 12 }),
});
export type BookReaderProfile = Static<typeof BookReaderProfileSchema>;

// The reader-facing pre-reading briefing, produced as four short labelled sections instead of
// one long blob so the frontend can render a scannable BriefCard. Each field is capped tight
// (≤220 字) to keep it genuinely brief; the system prompt asks for 1-2 sentences per field.
// snake_case here (agent tool convention); mapped to the camelCase contracts Briefing on save.
export const ReadingBriefingSchema = Type.Object({
  book_identity: Type.String({ minLength: 10, maxLength: 220 }),
  arc: Type.String({ minLength: 10, maxLength: 220 }),
  assumed_knowledge: Type.String({ minLength: 10, maxLength: 220 }),
  reading_advice: Type.String({ minLength: 10, maxLength: 220 }),
});
export type ReadingBriefing = Static<typeof ReadingBriefingSchema>;

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

export const TrialCandidateSchema = Type.Object({
  section_id: Type.String({ minLength: 1, maxLength: 200 }),
  segment: Type.Integer({ minimum: 1 }),
  reason: Type.String({ minLength: 5, maxLength: 500 }),
});
export type TrialCandidate = Static<typeof TrialCandidateSchema>;

export const TrialCandidatesSchema = Type.Array(TrialCandidateSchema, { minItems: 3, maxItems: 3 });

export const ReadingStrategySchema = Type.Object({
  ...READING_STRATEGY_CORE,
  trial_candidates: TrialCandidatesSchema,
});
export type ReadingStrategy = Static<typeof ReadingStrategySchema>;

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

// select_trial_fragments (§3.5): after the strategy is approved the agent reads the
// candidate node bodies and picks exactly three non-overlapping, self-contained
// fragments — each a contiguous block range inside one tailoring-eligible node —
// covering the entry threshold / typical content / hardest content. The range lets
// the host build trial_segments on the agent's choice instead of the mechanical
// first-six-blocks rangeForNode it replaces. The agent selects only block boundaries;
// the host derives exact UTF-16 offsets from the source text. `blockIndex` is 1-based.
export const TrialFragmentSchema = Type.Object({
  sectionId: Type.String({ minLength: 1, maxLength: 200 }),
  segment: Type.Integer({ minimum: 1 }),
  tag: Type.Union([Type.Literal('threshold'), Type.Literal('typical'), Type.Literal('hardest')]),
  range: Type.Object({
    start: Type.Object({
      blockIndex: Type.Integer({ minimum: 1 }),
    }),
    end: Type.Object({
      blockIndex: Type.Integer({ minimum: 1 }),
    }),
  }),
  reason: Type.String({ minLength: 5, maxLength: 500 }),
});
export type TrialFragmentSelection = Static<typeof TrialFragmentSchema>;

export type ReadingSetupToolName =
  | 'present_interview_question'
  | 'finish_interview'
  | 'submit_reading_briefing'
  | 'submit_reading_strategy'
  | 'submit_trial_candidates'
  | 'submit_interview_profile'
  | 'complete_interview_result'
  | 'save_strategy_draft'
  | 'select_trial_fragments';

export type ReadingBriefingField =
  | 'book_identity'
  | 'arc'
  | 'assumed_knowledge'
  | 'reading_advice';

type SpeculativeDelta<T> = T & { speculativeEpoch: number };

export type ReadingSetupStreamDelta =
  | {
      type: 'speculative_reset';
      speculativeEpoch: number;
      toolName: ReadingSetupToolName | null;
    }
  | SpeculativeDelta<{ type: 'ack_delta'; chars: string }>
  | SpeculativeDelta<{ type: 'prompt_delta'; chars: string }>
  | SpeculativeDelta<{ type: 'hint_delta'; chars: string }>
  | SpeculativeDelta<{ type: 'option_added'; id: string; label: string }>
  | SpeculativeDelta<{ type: 'sufficiency'; value: number }>
  | SpeculativeDelta<{ type: 'draft_started'; source: 'interview' | 'revision' }>
  | SpeculativeDelta<{ type: 'briefing_delta'; field: ReadingBriefingField; chars: string }>
  | SpeculativeDelta<{ type: 'strategy_delta'; chars: string }>
  | SpeculativeDelta<{
      type: 'reading_node_added';
      ordinal: number;
      sectionId: string;
      segment: number;
      reason: string;
    }>
  | SpeculativeDelta<{ type: 'selection_started'; total: 3 }>
  | SpeculativeDelta<{
      type: 'fragment_added';
      ordinal: number;
      fragment: TrialFragmentSelection;
    }>;

type CompletedArrayItem = { raw: string; end: number };

function isReadingSetupToolName(name: string): name is ReadingSetupToolName {
  return name === 'present_interview_question'
    || name === 'finish_interview'
    || name === 'submit_reading_briefing'
    || name === 'submit_reading_strategy'
    || name === 'submit_trial_candidates'
    || name === 'submit_interview_profile'
    || name === 'complete_interview_result'
    || name === 'save_strategy_draft'
    || name === 'select_trial_fragments';
}

function isInterviewCompletionTool(name: ReadingSetupToolName | undefined): boolean {
  return name === 'finish_interview'
    || name === 'submit_reading_briefing'
    || name === 'submit_reading_strategy'
    || name === 'submit_trial_candidates'
    || name === 'submit_interview_profile'
    || name === 'complete_interview_result';
}

function findNamedValueStart(source: string, propertyName: string): number | undefined {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '"') continue;
    const start = index;
    let escaped = false;
    index += 1;
    for (; index < source.length; index += 1) {
      const char = source[index]!;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') break;
    }
    if (index >= source.length) return undefined;
    let key: unknown;
    try {
      key = JSON.parse(source.slice(start, index + 1));
    } catch {
      continue;
    }
    if (key !== propertyName) continue;
    let cursor = index + 1;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] !== ':') continue;
    cursor += 1;
    while (/\s/.test(source[cursor] ?? '')) cursor += 1;
    return cursor < source.length ? cursor : undefined;
  }
  return undefined;
}

function findNamedArrayStart(source: string, propertyName: string): number | undefined {
  const valueStart = findNamedValueStart(source, propertyName);
  return valueStart !== undefined && source[valueStart] === '[' ? valueStart : undefined;
}

// Extracts only array items whose object-closing brace has actually arrived in the raw stream.
// Unlike completeJson(), this never invents a closing quote, bracket, brace, or number delimiter.
function scanCompletedArrayItems(source: string, propertyName: string): CompletedArrayItem[] {
  const arrayStart = findNamedArrayStart(source, propertyName);
  if (arrayStart === undefined) return [];
  const items: CompletedArrayItem[] = [];
  let cursor = arrayStart + 1;
  while (cursor < source.length) {
    while (/\s|,/.test(source[cursor] ?? '')) cursor += 1;
    if (source[cursor] === ']' || cursor >= source.length) break;
    if (source[cursor] !== '{') break;
    const itemStart = cursor;
    let objectDepth = 0;
    let arrayDepth = 0;
    let inString = false;
    let escaped = false;
    let completed = false;
    for (; cursor < source.length; cursor += 1) {
      const char = source[cursor]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') objectDepth += 1;
      else if (char === '[') arrayDepth += 1;
      else if (char === ']') arrayDepth -= 1;
      else if (char === '}') {
        objectDepth -= 1;
        if (objectDepth === 0 && arrayDepth === 0) {
          const end = cursor + 1;
          items.push({ raw: source.slice(itemStart, end), end });
          cursor = end;
          completed = true;
          break;
        }
      }
      if (objectDepth < 0 || arrayDepth < 0) return items;
    }
    if (!completed) break;
  }
  return items;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum;
}

function parseQuestionOption(raw: string): { id: string; label: string } | undefined {
  try {
    const value = recordValue(JSON.parse(raw));
    if (!value || !boundedString(value.id, 1, 100) || !boundedString(value.label, 1, 80)) return undefined;
    return { id: value.id, label: value.label };
  } catch {
    return undefined;
  }
}

function parseTrialCandidate(raw: string): { sectionId: string; segment: number; reason: string } | undefined {
  try {
    const value = recordValue(JSON.parse(raw));
    if (
      !value
      || !boundedString(value.section_id, 1, 200)
      || !Number.isInteger(value.segment)
      || (value.segment as number) < 1
      || !boundedString(value.reason, 5, 500)
    ) return undefined;
    return { sectionId: value.section_id, segment: value.segment as number, reason: value.reason };
  } catch {
    return undefined;
  }
}

function parseTrialBlockBoundary(value: unknown): { blockIndex: number } | undefined {
  const boundary = recordValue(value);
  if (
    !boundary
    || !Number.isInteger(boundary.blockIndex)
    || (boundary.blockIndex as number) < 1
  ) return undefined;
  return { blockIndex: boundary.blockIndex as number };
}

function parseTrialFragment(raw: string): TrialFragmentSelection | undefined {
  try {
    const value = recordValue(JSON.parse(raw));
    const range = recordValue(value?.range);
    const start = parseTrialBlockBoundary(range?.start);
    const end = parseTrialBlockBoundary(range?.end);
    if (
      !value
      || !boundedString(value.sectionId, 1, 200)
      || !Number.isInteger(value.segment)
      || (value.segment as number) < 1
      || (value.tag !== 'threshold' && value.tag !== 'typical' && value.tag !== 'hardest')
      || !start
      || !end
      || !boundedString(value.reason, 5, 500)
    ) return undefined;
    return {
      sectionId: value.sectionId,
      segment: value.segment as number,
      tag: value.tag,
      range: { start, end },
      reason: value.reason,
    };
  } catch {
    return undefined;
  }
}

function inferReadingSetupTool(
  buffer: string,
  phase?: ReadingSetupPhase,
): ReadingSetupToolName | undefined {
  const parsed = recordValue(completeJson(buffer));
  if (!parsed) return undefined;
  const keys = new Set(Object.keys(parsed));
  if (keys.has('acknowledgment') || keys.has('prompt') || keys.has('options')) {
    return 'present_interview_question';
  }
  if (keys.has('fragments')) return 'select_trial_fragments';
  if (keys.has('book_identity') || keys.has('arc') || keys.has('assumed_knowledge')) {
    return 'submit_reading_briefing';
  }
  if (keys.has('book_reader_profile') || keys.has('reader_profile_patch')) {
    return 'submit_interview_profile';
  }
  if (keys.has('candidates')) return 'submit_trial_candidates';
  if (keys.has('public_strategy') || keys.has('strategy')) {
    return phase === 'strategy_review' ? 'save_strategy_draft' : 'submit_reading_strategy';
  }
  return undefined;
}

export function createReadingSetupStreamParser(
  emit: (delta: ReadingSetupStreamDelta) => void,
  phase?: ReadingSetupPhase,
) {
  let speculativeEpoch = 0;
  let toolName: ReadingSetupToolName | undefined;
  let acceptedCompletion: CompletionSnapshot | undefined;
  let ignoreCurrentTool = false;
  let buffer = '';
  let startedForEpoch = false;
  let completionFlow = false;
  let completionDraftStarted = false;
  let consumedOptionsEnd = 0;
  let consumedCandidatesEnd = 0;
  let consumedFragmentsEnd = 0;
  let emittedCandidates = 0;
  let emittedFragments = 0;
  let emitted = {
    ack: 0,
    prompt: 0,
    hint: 0,
    strategy: 0,
    briefing: {
      book_identity: 0,
      arc: 0,
      assumed_knowledge: 0,
      reading_advice: 0,
    } satisfies Record<ReadingBriefingField, number>,
    sufficiency: undefined as number | undefined,
  };

  const withEpoch = <T extends object>(delta: T): T & { speculativeEpoch: number } => ({
    ...delta,
    speculativeEpoch,
  });

  const emitToolStarted = () => {
    if (!toolName || startedForEpoch) return;
    startedForEpoch = true;
    if (toolName === 'save_strategy_draft') {
      emit(withEpoch({ type: 'draft_started' as const, source: 'revision' as const }));
    } else if (toolName === 'select_trial_fragments') {
      emit(withEpoch({ type: 'selection_started' as const, total: 3 as const }));
    }
  };

  const expectedCompletionTool = (): ReadingSetupToolName => {
    if (!acceptedCompletion?.completionId) return 'finish_interview';
    if (!acceptedCompletion.briefing) return 'submit_reading_briefing';
    if (!acceptedCompletion.strategy) return 'submit_reading_strategy';
    if (!acceptedCompletion.candidates) return 'submit_trial_candidates';
    if (!acceptedCompletion.profile) return 'submit_interview_profile';
    return 'complete_interview_result';
  };

  const emitAcceptedCompletion = () => {
    if (!acceptedCompletion?.completionId) return;
    if (!completionDraftStarted) {
      completionDraftStarted = true;
      emit(withEpoch({ type: 'draft_started' as const, source: 'interview' as const }));
    }
    if (acceptedCompletion.briefing) {
      for (const field of ['book_identity', 'arc', 'assumed_knowledge', 'reading_advice'] as const) {
        const value = acceptedCompletion.briefing[field];
        const previousLength = emitted.briefing[field];
        if (value.length > previousLength) {
          emit(withEpoch({
            type: 'briefing_delta' as const,
            field,
            chars: value.slice(previousLength),
          }));
        }
        emitted.briefing[field] = value.length;
      }
    }
    if (acceptedCompletion.strategy) {
      const value = acceptedCompletion.strategy.publicStrategy;
      if (value.length > emitted.strategy) {
        emit(withEpoch({ type: 'strategy_delta' as const, chars: value.slice(emitted.strategy) }));
      }
      emitted.strategy = value.length;
    }
    if (acceptedCompletion.candidates) {
      for (let index = emittedCandidates; index < acceptedCompletion.candidates.length; index += 1) {
        const candidate = acceptedCompletion.candidates[index]!;
        emit(withEpoch({
          type: 'reading_node_added' as const,
          ordinal: index + 1,
          sectionId: candidate.section_id,
          segment: candidate.segment,
          reason: candidate.reason,
        }));
      }
      emittedCandidates = acceptedCompletion.candidates.length;
    }
  };

  const reset = (name: string) => {
    speculativeEpoch += 1;
    toolName = isReadingSetupToolName(name) ? name : undefined;
    ignoreCurrentTool = false;
    buffer = '';
    startedForEpoch = false;
    completionFlow = isInterviewCompletionTool(toolName);
    completionDraftStarted = false;
    consumedOptionsEnd = 0;
    consumedCandidatesEnd = 0;
    consumedFragmentsEnd = 0;
    emittedCandidates = 0;
    emittedFragments = 0;
    emitted = {
      ack: 0,
      prompt: 0,
      hint: 0,
      strategy: 0,
      briefing: { book_identity: 0, arc: 0, assumed_knowledge: 0, reading_advice: 0 },
      sufficiency: undefined,
    };
    emit({ type: 'speculative_reset', speculativeEpoch, toolName: toolName ?? null });
    emitToolStarted();
    if (completionFlow) emitAcceptedCompletion();
  };

  const switchTool = (name: ReadingSetupToolName) => {
    toolName = name;
    ignoreCurrentTool = false;
    buffer = '';
    startedForEpoch = false;
    consumedOptionsEnd = 0;
    consumedCandidatesEnd = 0;
    consumedFragmentsEnd = 0;
    emitToolStarted();
  };

  const emitStringSuffix = (
    value: unknown,
    previousLength: number,
    create: (chars: string) => ReadingSetupStreamDelta,
  ): number => {
    if (typeof value !== 'string' || value.length <= previousLength) return previousLength;
    emit(create(value.slice(previousLength)));
    return value.length;
  };

  return {
    onToolStart(name: string) {
      const nextTool = isReadingSetupToolName(name) ? name : undefined;
      if (completionFlow && !nextTool) {
        toolName = undefined;
        ignoreCurrentTool = false;
        buffer = '';
        startedForEpoch = false;
        consumedOptionsEnd = 0;
        consumedCandidatesEnd = 0;
        consumedFragmentsEnd = 0;
        return;
      }
      if (isInterviewCompletionTool(nextTool) && nextTool) {
        const expectedTool = expectedCompletionTool();
        if (nextTool !== expectedTool) {
          reset(name);
          ignoreCurrentTool = true;
          return;
        }
        if (completionFlow && nextTool !== toolName) {
          switchTool(nextTool);
          return;
        }
      }
      reset(name);
    },
    onToolSucceeded(name: string) {
      if (
        name === 'finish_interview'
        && toolName === 'finish_interview'
        && !completionDraftStarted
      ) {
        acceptedCompletion ??= {
          completionId: 'accepted-by-host',
          baseConversationVersion: null,
        };
        completionDraftStarted = true;
        emit(withEpoch({ type: 'draft_started' as const, source: 'interview' as const }));
      }
    },
    acceptCompletion(snapshot: CompletionSnapshot) {
      acceptedCompletion = snapshot;
      emitAcceptedCompletion();
    },
    replayCompletion(snapshot: CompletionSnapshot) {
      acceptedCompletion = snapshot;
      if (!snapshot.completionId) return;
      speculativeEpoch += 1;
      toolName = undefined;
      buffer = '';
      startedForEpoch = false;
      completionFlow = true;
      completionDraftStarted = false;
      consumedOptionsEnd = 0;
      consumedCandidatesEnd = 0;
      consumedFragmentsEnd = 0;
      emittedCandidates = 0;
      emittedFragments = 0;
      emitted = {
        ack: 0,
        prompt: 0,
        hint: 0,
        strategy: 0,
        briefing: { book_identity: 0, arc: 0, assumed_knowledge: 0, reading_advice: 0 },
        sufficiency: undefined,
      };
      emit({ type: 'speculative_reset', speculativeEpoch, toolName: null });
      emitAcceptedCompletion();
    },
    onDelta(delta: string) {
      if (ignoreCurrentTool) return;
      buffer += delta;
      if (!toolName) {
        const inferredTool = inferReadingSetupTool(buffer, phase);
        if (
          isInterviewCompletionTool(inferredTool)
          && inferredTool !== expectedCompletionTool()
        ) {
          ignoreCurrentTool = true;
          return;
        }
        toolName = inferredTool;
        if (isInterviewCompletionTool(toolName)) completionFlow = true;
        emitToolStarted();
      }
      if (!toolName) return;
      const parsed = recordValue(completeJson(buffer));
      if (!parsed) return;

      if (toolName === 'present_interview_question') {
        emitted.ack = emitStringSuffix(parsed.acknowledgment, emitted.ack, (chars) => withEpoch({ type: 'ack_delta' as const, chars }));
        emitted.prompt = emitStringSuffix(parsed.prompt, emitted.prompt, (chars) => withEpoch({ type: 'prompt_delta' as const, chars }));
        emitted.hint = emitStringSuffix(parsed.hint, emitted.hint, (chars) => withEpoch({ type: 'hint_delta' as const, chars }));
        for (const item of scanCompletedArrayItems(buffer, 'options')) {
          if (item.end <= consumedOptionsEnd) continue;
          const option = parseQuestionOption(item.raw);
          if (!option) break;
          emit(withEpoch({ type: 'option_added' as const, ...option }));
          consumedOptionsEnd = item.end;
        }
        if (
          typeof parsed.sufficiency === 'number'
          && Number.isInteger(parsed.sufficiency)
          && emitted.sufficiency !== parsed.sufficiency
          && /"sufficiency"\s*:\s*-?\d+\s*[,}\]]/.test(buffer)
        ) {
          emitted.sufficiency = parsed.sufficiency;
          emit(withEpoch({ type: 'sufficiency' as const, value: parsed.sufficiency }));
        }
        return;
      }

      if (toolName === 'submit_reading_briefing') {
        for (const field of ['book_identity', 'arc', 'assumed_knowledge', 'reading_advice'] as const) {
          emitted.briefing[field] = emitStringSuffix(
            parsed[field],
            emitted.briefing[field],
            (chars) => withEpoch({ type: 'briefing_delta' as const, field, chars }),
          );
        }
        return;
      }

      if (toolName === 'submit_reading_strategy' || toolName === 'save_strategy_draft') {
        emitted.strategy = emitStringSuffix(
          parsed.public_strategy,
          emitted.strategy,
          (chars) => withEpoch({ type: 'strategy_delta' as const, chars }),
        );
        if (toolName === 'submit_reading_strategy') return;
      }

      if (toolName === 'submit_trial_candidates' || toolName === 'save_strategy_draft') {
        const propertyName = toolName === 'submit_trial_candidates' ? 'candidates' : 'trial_candidates';
        for (const item of scanCompletedArrayItems(buffer, propertyName)) {
          if (item.end <= consumedCandidatesEnd) continue;
          const candidate = parseTrialCandidate(item.raw);
          if (!candidate) break;
          emit(withEpoch({
            type: 'reading_node_added' as const,
            ordinal: emittedCandidates + 1,
            ...candidate,
          }));
          consumedCandidatesEnd = item.end;
          emittedCandidates += 1;
        }
        return;
      }

      for (const item of scanCompletedArrayItems(buffer, 'fragments')) {
        if (item.end <= consumedFragmentsEnd) continue;
        const fragment = parseTrialFragment(item.raw);
        if (!fragment) break;
        emit(withEpoch({
          type: 'fragment_added' as const,
          ordinal: emittedFragments + 1,
          fragment,
        }));
        consumedFragmentsEnd = item.end;
        emittedFragments += 1;
      }
    },
  };
}

export type ReadingSetupPhase = 'interviewing' | 'strategy_review' | 'select_trial';

export type SubmittedReadingStrategy = {
  publicStrategy: string;
  strategy: ReadingStrategyCore;
};

export type SubmittedInterviewProfile = {
  bookReaderProfile: BookReaderProfile;
  readerProfilePatch?: ReaderProfilePatch;
};

export type CompletionSnapshot = {
  completionId: string | null;
  baseConversationVersion: number | null;
  briefing?: ReadingBriefing;
  strategy?: SubmittedReadingStrategy;
  candidates?: TrialCandidate[];
  profile?: SubmittedInterviewProfile;
};

export type CompletedInterviewArtifacts = {
  briefing: ReadingBriefing;
  strategy: SubmittedReadingStrategy;
  candidates: TrialCandidate[];
  profile: SubmittedInterviewProfile;
};

/**
 * Durable completion checkpoints for an interviewing turn. The API binds an implementation
 * to the currently claimed session/lease; agent-kit only enforces tool order and never knows
 * about database transactions or fencing columns.
 */
export interface InterviewCompletionStore {
  load(): Promise<CompletionSnapshot>;
  start(): Promise<CompletionSnapshot>;
  submitBriefing(value: ReadingBriefing): Promise<CompletionSnapshot>;
  submitStrategy(value: SubmittedReadingStrategy): Promise<CompletionSnapshot>;
  submitCandidates(value: TrialCandidate[]): Promise<CompletionSnapshot>;
  submitProfile(value: SubmittedInterviewProfile): Promise<CompletionSnapshot>;
  complete(): Promise<CompletedInterviewArtifacts>;
}

export type ReadingSetupOutcome =
  | { type: 'question'; question: InterviewQuestion }
  | {
      type: 'completed';
      bookReaderProfile: BookReaderProfile;
      readerProfilePatch?: ReaderProfilePatch;
      briefing: ReadingBriefing;
      publicStrategy: string;
      strategy: ReadingStrategy;
    }
  | {
      type: 'revised';
      publicStrategy: string;
      strategy: ReadingStrategy;
      bookReaderProfile?: BookReaderProfile;
    }
  | { type: 'fragments'; fragments: TrialFragmentSelection[] };

export type ReadingSetupCallMetrics = {
  // Cumulative provider-formatted messages + tools JSON across all model turns.
  promptChars: number | null;
  // Cumulative assistant text + tool-argument JSON across all completed model turns.
  outputChars: number | null;
};

const READING_SETUP_SYSTEM_PROMPT = `你是 ReadTailor 的单本书访谈与处理方式 Agent。你只处理当前用户与当前书的阅读准备，不修改原文。访谈阶段信息不足时调用 present_interview_question；信息足够或已达到问题上限时先调用无参数的 finish_interview，确定性结束问答。finish_interview 成功后不得再次提问，必须依次调用 submit_reading_briefing、submit_reading_strategy、submit_trial_candidates、submit_interview_profile，最后调用 complete_interview_result。每个提交工具成功后结果都会持久化；恢复时不要重复生成已有阶段，从第一个缺失阶段继续。问题必须直接服务于本书处理方式，不重复长期画像中的明确信息，每次只问一题，给出 2-5 个清晰选项并允许文字补充。访谈是轻快的口语对话，务必言简意赅、克制不铺陈：acknowledgment 用一句短话回应用户上一答（30 字以内，首问留空串）；prompt 一般 40 字以内；hint 说明问题如何影响本书处理方式（40 字以内）；每个选项 label 15 字以内；sufficiency 给出 0-100 的信息充足度自评。读前简报是四段结构化短内容，每段只写 1-2 句：book_identity（本书定位与价值）；arc（全书脉络）；assumed_knowledge（默认背景及读者落差）；reading_advice（针对读者的具体读法）。结构化策略要如实产出整体 goals、expression_principles，以及 guide、annotations、after_reading 三段的 enabled 和对应要点；某段无价值就设为 false 并留空要点。trial candidates 从 book profile 候选池中选择恰好三个不同候选，覆盖进入门槛、典型内容和较高难度内容。你没有确认权限，不能批准试读或创建正式策略。`;

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

/**
 * Rebuilds the one-per-user-book logical conversation from persisted business data so
 * every turn — first question, interview, and strategy revision — is "warm": the merged
 * agent sees the whole interview plus the latest draft instead of a cold `messages: []`
 * seeded only with a JSON blob. Prior turns are replayed as plain-text messages (no
 * tool-call parts), keeping the reconstruction API-safe regardless of a provider's
 * tool-call / tool-result pairing rules. `context.messages` rows already carry the
 * persisted role (question=assistant, answer/feedback=user), so they map directly.
 */
export function reconstructReadingSetupHistory(
  context: Record<string, unknown>,
  modelName: string,
): AgentMessage[] {
  const messages: AgentMessage[] = [];
  const background = {
    book: context.book,
    bookProfile: context.bookProfile,
    readerProfile: context.readerProfile,
  };
  messages.push(userTurnMessage(`【长期画像与书籍资料】\n${JSON.stringify(background, null, 2)}`));
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
  if (context.currentStrategy && typeof context.currentStrategy === 'object') {
    messages.push(assistantTurnMessage(
      `【当前处理方式草稿】\n${JSON.stringify(context.currentStrategy, null, 2)}`,
      modelName,
    ));
  }
  // The select_trial turn ships the candidate node bodies (host-extracted blocks with
  // their 1-based blockIndex) so the agent can pick real block ranges in one turn.
  if (Array.isArray(context.trialNodeContents) && context.trialNodeContents.length > 0) {
    messages.push(userTurnMessage(
      `【候选试读节点正文（用于选片段，blockIndex 为节点内 1 基编号）】\n${JSON.stringify(context.trialNodeContents, null, 2)}`,
    ));
  }
  return messages;
}

function jsonChars(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function modelPromptChars(payload: unknown): number {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return jsonChars(payload);
  const source = payload as { messages?: unknown; tools?: unknown };
  const promptPayload: Record<string, unknown> = {};
  if (source.messages !== undefined) promptPayload.messages = source.messages;
  if (source.tools !== undefined) promptPayload.tools = source.tools;
  return Object.keys(promptPayload).length > 0 ? jsonChars(promptPayload) : jsonChars(payload);
}

function assistantOutputChars(message: AgentMessage): number {
  if (message.role !== 'assistant') return 0;
  return message.content.reduce((total, part) => {
    if (part.type === 'text') return total + part.text.length;
    if (part.type === 'toolCall') return total + jsonChars(part.arguments);
    return total;
  }, 0);
}

// One agent, one logical business session per user_book, covering interview → strategy
// review/revision (agent_design §2/§3.3/§6). Pi sessions only live inside a single request,
// so each turn rebuilds the conversation from the database (see reconstructReadingSetupHistory)
// instead of cold-starting; the phase decides which tools are exposed (§3.2, least privilege).
export async function runReadingSetupAgent(options: {
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  sessionId: string;
  phase: ReadingSetupPhase;
  askedCount: number;
  context: Record<string, unknown>;
  feedback?: string;
  completionStore?: InterviewCompletionStore;
  maxTurns?: number;
  timeoutMs?: number;
  onTrace?: AgentTraceHandler;
  onReadingSetupStream?: (delta: ReadingSetupStreamDelta) => void;
  onMetrics?: (metrics: ReadingSetupCallMetrics) => void;
}): Promise<ReadingSetupOutcome> {
  let outcome: ReadingSetupOutcome | undefined;
  let promptChars: number | null = null;
  let outputChars: number | null = null;
  let turns = 0;
  let toolCalls = 0;
  let limitExceeded = false;
  const maxTurns = options.maxTurns ?? 12;
  const tools: AgentTool[] = [];
  let completionSnapshot: CompletionSnapshot = {
    completionId: null,
    baseConversationVersion: null,
  };
  let streamParser: ReturnType<typeof createReadingSetupStreamParser> | undefined;

  if (options.phase === 'interviewing') {
    completionSnapshot = options.completionStore
      ? await options.completionStore.load()
      : completionSnapshot;
    const requireStore = (): InterviewCompletionStore => {
      if (!options.completionStore) {
        throw new Error('Interview completion store is not configured.');
      }
      return options.completionStore;
    };
    const requireStarted = () => {
      if (!completionSnapshot.completionId) {
        throw new Error('Call finish_interview before submitting completion artifacts.');
      }
    };

    if (options.askedCount < 7 && !completionSnapshot.completionId) {
      tools.push({
        name: 'present_interview_question',
        label: 'Present interview question',
        description: '信息仍不足时，提交下一道要展示给用户的问题。',
        parameters: InterviewQuestionSchema,
        executionMode: 'sequential',
        execute: async (_id, input) => {
          if (completionSnapshot.completionId) {
            throw new Error('The interview is already finishing; no more questions are allowed.');
          }
          outcome = { type: 'question', question: input as InterviewQuestion };
          return {
            content: [{ type: 'text' as const, text: 'Interview question accepted.' }],
            details: { questionId: (input as InterviewQuestion).id },
            terminate: true,
          };
        },
      });
    }
    if (options.askedCount > 0 && !completionSnapshot.completionId) {
      tools.push({
        name: 'finish_interview',
        label: 'Finish interview',
        description: '信息已经足够或问题达到上限时，结束问答阶段。这个工具没有参数，也不提交生成产物。',
        parameters: Type.Object({}),
        executionMode: 'sequential',
        execute: async () => {
          completionSnapshot = await requireStore().start();
          streamParser?.acceptCompletion(completionSnapshot);
          return {
            content: [{ type: 'text' as const, text: 'Interview closed. Submit the reading briefing next.' }],
            details: { completionId: completionSnapshot.completionId },
          };
        },
      });
    }
    if (options.askedCount > 0 || completionSnapshot.completionId) {
      tools.push(
        {
          name: 'submit_reading_briefing',
          label: 'Submit reading briefing',
          description: '提交四段个性化读前简报。必须在 finish_interview 之后首先调用。',
          parameters: ReadingBriefingSchema,
          executionMode: 'sequential',
          execute: async (_id, input) => {
            requireStarted();
            completionSnapshot = await requireStore().submitBriefing(input as ReadingBriefing);
            streamParser?.acceptCompletion(completionSnapshot);
            return {
              content: [{ type: 'text' as const, text: 'Reading briefing saved. Submit the reading strategy next.' }],
              details: { saved: true },
            };
          },
        },
        {
          name: 'submit_reading_strategy',
          label: 'Submit reading strategy',
          description: '提交用户可读处理方式和不含试读候选的结构化策略。',
          parameters: Type.Object({
            public_strategy: Type.String({ minLength: 50, maxLength: 8000 }),
            strategy: ReadingStrategyCoreSchema,
          }),
          executionMode: 'sequential',
          execute: async (_id, input) => {
            requireStarted();
            if (!completionSnapshot.briefing) {
              throw new Error('Submit the reading briefing before the reading strategy.');
            }
            const value = input as { public_strategy: string; strategy: ReadingStrategyCore };
            completionSnapshot = await requireStore().submitStrategy({
              publicStrategy: value.public_strategy,
              strategy: value.strategy,
            });
            streamParser?.acceptCompletion(completionSnapshot);
            return {
              content: [{ type: 'text' as const, text: 'Reading strategy saved. Submit trial candidates next.' }],
              details: { saved: true },
            };
          },
        },
        {
          name: 'submit_trial_candidates',
          label: 'Submit trial candidates',
          description: '从 book profile 候选池提交恰好三个不同的试读候选。',
          parameters: Type.Object({ candidates: TrialCandidatesSchema }),
          executionMode: 'sequential',
          execute: async (_id, input) => {
            requireStarted();
            if (!completionSnapshot.strategy) {
              throw new Error('Submit the reading strategy before trial candidates.');
            }
            const value = input as { candidates: TrialCandidate[] };
            completionSnapshot = await requireStore().submitCandidates(value.candidates);
            streamParser?.acceptCompletion(completionSnapshot);
            return {
              content: [{ type: 'text' as const, text: 'Trial candidates saved. Submit the interview profile next.' }],
              details: { trialCandidateCount: value.candidates.length },
            };
          },
        },
        {
          name: 'submit_interview_profile',
          label: 'Submit interview profile',
          description: '提交本书读者画像和可选的长期画像补丁。',
          parameters: Type.Object({
            book_reader_profile: BookReaderProfileSchema,
            reader_profile_patch: Type.Optional(ReaderProfilePatchSchema),
          }),
          executionMode: 'sequential',
          execute: async (_id, input) => {
            requireStarted();
            if (!completionSnapshot.candidates) {
              throw new Error('Submit trial candidates before the interview profile.');
            }
            const value = input as {
              book_reader_profile: BookReaderProfile;
              reader_profile_patch?: ReaderProfilePatch;
            };
            completionSnapshot = await requireStore().submitProfile({
              bookReaderProfile: value.book_reader_profile,
              ...(value.reader_profile_patch ? { readerProfilePatch: value.reader_profile_patch } : {}),
            });
            streamParser?.acceptCompletion(completionSnapshot);
            return {
              content: [{ type: 'text' as const, text: 'Interview profile saved. Complete the interview result next.' }],
              details: { saved: true },
            };
          },
        },
        {
          name: 'complete_interview_result',
          label: 'Complete interview result',
          description: '所有四类产物保存后，组装完整访谈结果并结束本次 Agent run。这个工具没有参数。',
          parameters: Type.Object({}),
          executionMode: 'sequential',
          execute: async () => {
            requireStarted();
            if (
              !completionSnapshot.briefing
              || !completionSnapshot.strategy
              || !completionSnapshot.candidates
              || !completionSnapshot.profile
            ) {
              throw new Error('All completion artifacts must be submitted before completing the result.');
            }
            const artifacts = await requireStore().complete();
            outcome = {
              type: 'completed',
              bookReaderProfile: artifacts.profile.bookReaderProfile,
              ...(artifacts.profile.readerProfilePatch
                ? { readerProfilePatch: artifacts.profile.readerProfilePatch }
                : {}),
              briefing: artifacts.briefing,
              publicStrategy: artifacts.strategy.publicStrategy,
              strategy: {
                ...artifacts.strategy.strategy,
                trial_candidates: artifacts.candidates,
              },
            };
            return {
              content: [{ type: 'text' as const, text: 'Reading setup accepted.' }],
              details: { trialCandidateCount: artifacts.candidates.length },
              terminate: true,
            };
          },
        },
      );
    }
  } else if (options.phase === 'strategy_review') {
    tools.push({
      name: 'save_strategy_draft',
      label: 'Save strategy draft',
      description: '保存吸收本次反馈后的新处理方式草稿。',
      parameters: Type.Object({
        public_strategy: Type.String({ minLength: 50, maxLength: 8000 }),
        strategy: ReadingStrategySchema,
        book_reader_profile: Type.Optional(BookReaderProfileSchema),
      }),
      executionMode: 'sequential',
      execute: async (_id, input) => {
        const value = input as {
          public_strategy: string;
          strategy: ReadingStrategy;
          book_reader_profile?: BookReaderProfile;
        };
        outcome = {
          type: 'revised',
          publicStrategy: value.public_strategy,
          strategy: value.strategy,
          ...(value.book_reader_profile ? { bookReaderProfile: value.book_reader_profile } : {}),
        };
        return {
          content: [{ type: 'text' as const, text: 'Strategy draft accepted.' }],
          details: { trialCandidateCount: value.strategy.trial_candidates.length },
          terminate: true,
        };
      },
    });
  } else {
    tools.push({
      name: 'select_trial_fragments',
      label: 'Select trial fragments',
      description:
        '读过候选节点正文后，选出恰好三个互不重叠、可独立阅读的试读片段，分别覆盖进入门槛(threshold)/典型内容(typical)/较高难度(hardest)；每个片段只需给出 sectionId+segment 与节点内连续的起止 blockIndex，不要计算字符 offset，且 range 必须落在该节点已给出的 block 范围内。',
      parameters: Type.Object({
        fragments: Type.Array(TrialFragmentSchema, { minItems: 3, maxItems: 3 }),
      }),
      executionMode: 'sequential',
      execute: async (_id, input) => {
        const value = input as { fragments: TrialFragmentSelection[] };
        outcome = { type: 'fragments', fragments: value.fragments };
        return {
          content: [{ type: 'text' as const, text: 'Trial fragments accepted.' }],
          details: { fragmentCount: value.fragments.length },
          terminate: true,
        };
      },
    });
  }

  const completionProgress = options.phase === 'interviewing' && completionSnapshot.completionId
    ? `\n当前问答已经结束。持久化完成进度：briefing=${Boolean(completionSnapshot.briefing)}，strategy=${Boolean(completionSnapshot.strategy)}，candidates=${Boolean(completionSnapshot.candidates)}，profile=${Boolean(completionSnapshot.profile)}。不要提问或重新生成已完成阶段，直接调用第一个缺失阶段的工具；全部齐全时调用 complete_interview_result。`
    : '';
  const systemPrompt = options.phase === 'strategy_review'
    ? `${READING_SETUP_SYSTEM_PROMPT}\n当前处于处理方式确认阶段：请结合访谈历史与上一版草稿，吸收用户最新反馈后调用 save_strategy_draft 产出新草稿，保持连续性，不要提出新问题或确认策略。`
    : options.phase === 'select_trial'
      ? `${READING_SETUP_SYSTEM_PROMPT}\n当前处于试读片段选择阶段：处理方式已确认，请依据已给出的候选节点正文，调用 select_trial_fragments 选出恰好三个不重叠、可独立阅读的片段，分别标记 threshold/typical/hardest。只能引用候选节点，range 只填写连续的起止 blockIndex，不要填写或计算字符 offset，并且必须落在对应节点已列出的 block 范围内。优先命中最能体现处理价值的内容，不要提问或改动策略。`
      : `${READING_SETUP_SYSTEM_PROMPT}${completionProgress}`;
  const prompt = options.phase === 'strategy_review'
    ? `用户对当前处理方式草稿给出以下反馈，请吸收后调用 save_strategy_draft 产出新草稿：\n${options.feedback ?? ''}`
    : options.phase === 'select_trial'
      ? '处理方式已确认。请阅读上面给出的候选试读节点正文，调用 select_trial_fragments 选出恰好三个互不重叠、能独立阅读的片段（threshold/典型/hardest 各一），每个给出 sectionId+segment 与落在该节点内连续的起止 blockIndex；不要计算字符 offset。'
      : completionSnapshot.completionId
        ? '问答已经结束。请按照系统消息中的持久化完成进度，从第一个缺失阶段继续；不要重复生成已保存产物。'
        : `请根据以上长期画像、书籍资料与访谈对话继续本书访谈。已提出 ${options.askedCount} 道问题，最多 7 道。信息不足就用 present_interview_question 提下一题，信息足够或已达上限就先调用 finish_interview，再依序生成并提交四类产物。`;
  const messages = reconstructReadingSetupHistory(options.context, options.modelName);
  const reportMetrics = () => {
    try {
      options.onMetrics?.({ promptChars, outputChars });
    } catch {
      // Metrics collection must not change agent behavior.
    }
  };
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: createModel(options),
      thinkingLevel: 'medium',
      tools,
      messages,
    },
    sessionId: options.sessionId,
    getApiKey: () => options.apiKey,
    onPayload: (payload) => {
      promptChars = (promptChars ?? 0) + modelPromptChars(payload);
      reportMetrics();
    },
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
    } else if (event.type === 'message_end' && event.message.role === 'assistant') {
      outputChars = (outputChars ?? 0) + assistantOutputChars(event.message);
      reportMetrics();
    }
  });
  if (options.onReadingSetupStream) {
    streamParser = createReadingSetupStreamParser(options.onReadingSetupStream, options.phase);
    if (options.phase === 'interviewing' && completionSnapshot.completionId) {
      streamParser.replayCompletion(completionSnapshot);
    }
    agent.subscribe((event) => {
      if (event.type === 'message_update') {
        const streamed = event.assistantMessageEvent;
        if (streamed.type === 'toolcall_start') {
          const part = streamed.partial.content[streamed.contentIndex];
          streamParser?.onToolStart(part && part.type === 'toolCall' ? part.name : '');
        } else if (streamed.type === 'toolcall_delta') {
          streamParser?.onDelta(streamed.delta);
        }
      }
    });
  }
  subscribeAgentTrace(agent, {
    agentName: 'reading_setup',
    sessionId: options.sessionId,
    modelName: options.modelName,
    systemPrompt,
    prompt,
    getTurn: () => turns,
    getToolCalls: () => toolCalls,
    ...(options.onTrace ? { onTrace: options.onTrace } : {}),
  });
  const timeout = setTimeout(() => agent.abort(), options.timeoutMs ?? 5 * 60_000);
  try {
    await agent.prompt(prompt);
  } finally {
    clearTimeout(timeout);
  }
  if (!outcome) {
    if (limitExceeded) throw new Error(`reading setup agent exceeded the ${maxTurns}-turn limit`);
    throw new Error('reading setup agent stopped without submitting a result');
  }
  return outcome;
}

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

// ---------------------------------------------------------------------------
// 问 AI Agent (agent_design §8). Unlike the three agents above, this one is a
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
 * same "warm replay as plain text" approach as reconstructReadingSetupHistory — no Pi-native
 * session is ever stored. `context` carries: `questionContext` (the anchor for this question),
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
