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

// Token-level streaming for the interview (§4). As the model streams the
// present_interview_question tool call, its argument JSON arrives one fragment at a
// time; we parse the partial buffer and diff it against what we already emitted to push
// clean semantic deltas. `concluding` fires the moment we recognise finish_interview so
// the UI can switch to "generating briefing" without waiting for the (slow) full result.
export type InterviewStreamDelta =
  | { type: 'ack_delta'; chars: string }
  | { type: 'prompt_delta'; chars: string }
  | { type: 'hint_delta'; chars: string }
  | { type: 'option_added'; id: string; label: string }
  | { type: 'sufficiency'; value: number }
  | { type: 'concluding' };

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

// Stateful parser that turns a stream of tool-call argument fragments into interview
// deltas. Field order (id → acknowledgment → prompt → options → allow_text →
// profile_dimension → sufficiency) is assumed but not required: each field diffs
// independently, so out-of-order streaming degrades to "appears once complete".
export function createInterviewStreamParser(emit: (delta: InterviewStreamDelta) => void) {
  let toolName: string | undefined;
  let buffer = '';
  let concluded = false;
  const emitted = { ack: 0, prompt: 0, hint: 0, options: 0, sufficiency: undefined as number | undefined };

  const markConcluding = () => {
    if (concluded) return;
    concluded = true;
    emit({ type: 'concluding' });
  };

  return {
    // A new tool call started — reset the buffer for its argument stream. `name` comes from
    // the assistant message's tool-call content part (empty until the provider sends it).
    onToolStart(name: string) {
      buffer = '';
      if (name === 'present_interview_question' || name === 'finish_interview') toolName = name;
      if (name === 'finish_interview') markConcluding();
    },
    onDelta(delta: string) {
      buffer += delta;
      if (toolName === undefined) {
        // The tool name was not on toolcall_start — infer it from the argument keys.
        const probe = completeJson(buffer);
        if (probe && typeof probe === 'object') {
          const keys = Object.keys(probe);
          if (keys.some((k) => k === 'acknowledgment' || k === 'prompt' || k === 'options')) {
            toolName = 'present_interview_question';
          } else if (keys.some((k) => k === 'book_reader_profile' || k === 'briefing' || k === 'public_strategy')) {
            toolName = 'finish_interview';
            markConcluding();
          }
        }
      }
      if (toolName !== 'present_interview_question') return;
      const parsed = completeJson(buffer);
      if (!parsed || typeof parsed !== 'object') return;
      const obj = parsed as {
        acknowledgment?: unknown;
        prompt?: unknown;
        hint?: unknown;
        options?: unknown;
        allow_text?: unknown;
        profile_dimension?: unknown;
        sufficiency?: unknown;
      };
      if (typeof obj.acknowledgment === 'string' && obj.acknowledgment.length > emitted.ack) {
        emit({ type: 'ack_delta', chars: obj.acknowledgment.slice(emitted.ack) });
        emitted.ack = obj.acknowledgment.length;
      }
      if (typeof obj.prompt === 'string' && obj.prompt.length > emitted.prompt) {
        emit({ type: 'prompt_delta', chars: obj.prompt.slice(emitted.prompt) });
        emitted.prompt = obj.prompt.length;
      }
      // `hint` sits between prompt and options in the schema, so it streams here — after the
      // prompt, before the first option — which is the order the UI reveals them in.
      if (typeof obj.hint === 'string' && obj.hint.length > emitted.hint) {
        emit({ type: 'hint_delta', chars: obj.hint.slice(emitted.hint) });
        emitted.hint = obj.hint.length;
      }
      if (Array.isArray(obj.options)) {
        // The last parsed option may still be streaming; only treat it as complete once a
        // later field (allow_text / profile_dimension / sufficiency) has appeared.
        const optionsClosed =
          obj.allow_text !== undefined || obj.profile_dimension !== undefined || obj.sufficiency !== undefined;
        const safeCount = optionsClosed ? obj.options.length : obj.options.length - 1;
        for (let i = emitted.options; i < safeCount; i++) {
          const option = obj.options[i] as { id?: unknown; label?: unknown };
          if (option && typeof option.id === 'string' && option.id && typeof option.label === 'string' && option.label) {
            emit({ type: 'option_added', id: option.id, label: option.label });
            emitted.options = i + 1;
          } else {
            break; // don't skip past an option that isn't fully formed yet
          }
        }
      }
      if (
        typeof obj.sufficiency === 'number'
        && Number.isInteger(obj.sufficiency)
        && emitted.sufficiency !== obj.sufficiency
        // Only once the number is definitely terminated in the raw buffer (a delimiter follows).
        && /"sufficiency"\s*:\s*-?\d+\s*[,}\]]/.test(buffer)
      ) {
        emit({ type: 'sufficiency', value: obj.sufficiency });
        emitted.sufficiency = obj.sufficiency;
      }
    },
  };
}

export const ReaderProfilePatchSchema = Type.Object({
  knowledge: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 12 })),
  explanation_preferences: Type.Optional(
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

export const ReadingStrategySchema = Type.Object({
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
  trial_candidates: Type.Array(
    Type.Object({
      section_id: Type.String({ minLength: 1, maxLength: 200 }),
      segment: Type.Integer({ minimum: 1 }),
      reason: Type.String({ minLength: 5, maxLength: 500 }),
    }),
    { minItems: 3, maxItems: 3 },
  ),
});
export type ReadingStrategy = Static<typeof ReadingStrategySchema>;

// select_trial_fragments (§3.5): after the strategy is approved the agent reads the
// candidate node bodies and picks exactly three non-overlapping, self-contained
// fragments — each a contiguous block range inside one tailoring-eligible node —
// covering the entry threshold / typical content / hardest content. The range lets
// the host build trial_segments on the agent's choice instead of the mechanical
// first-six-blocks rangeForNode it replaces. `block_index` is 1-based within the node.
export const TrialFragmentSchema = Type.Object({
  section_id: Type.String({ minLength: 1, maxLength: 200 }),
  segment: Type.Integer({ minimum: 1 }),
  tag: Type.Union([Type.Literal('threshold'), Type.Literal('typical'), Type.Literal('hardest')]),
  range: Type.Object({
    start: Type.Object({
      block_index: Type.Integer({ minimum: 1 }),
      offset: Type.Integer({ minimum: 0 }),
    }),
    end: Type.Object({
      block_index: Type.Integer({ minimum: 1 }),
      offset: Type.Integer({ minimum: 0 }),
    }),
  }),
  reason: Type.String({ minLength: 5, maxLength: 500 }),
});
export type TrialFragmentSelection = Static<typeof TrialFragmentSchema>;

export type ReadingSetupPhase = 'interviewing' | 'strategy_review' | 'select_trial';

export type ReadingSetupOutcome =
  | { type: 'question'; question: InterviewQuestion }
  | {
      type: 'completed';
      bookReaderProfile: BookReaderProfile;
      readerProfilePatch?: ReaderProfilePatch;
      briefing: string;
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

const READING_SETUP_SYSTEM_PROMPT = `你是 ReadTailor 的单本书访谈与处理方式 Agent。你只处理当前用户与当前书的阅读准备，不修改原文。每轮必须调用一个宿主工具结束：信息不足时调用 present_interview_question；信息足够或已达到问题上限时调用 finish_interview。问题必须直接服务于本书处理方式，不重复长期画像中的明确信息，每次只问一题，给出 2-5 个清晰选项并允许文字补充。访谈是轻快的口语对话，务必言简意赅、克制不铺陈，不要长篇大论：acknowledgment 用一句短话真实回应用户上一答（30 字以内，不复述整段、不堆砌寒暄，首问留空串）；prompt 用一句话把问题问清楚（一般 40 字以内，不加铺垫、背景解释或多余修饰）；hint 一句话说明为什么问这道题、它会如何影响本书处理方式（40 字以内，贴着当前问题写、不空泛）；每个选项 label 是一个简短短语（15 字以内，不写成整句）；sufficiency 给出 0-100 的信息充足度自评（可随判断诚实回落）。finish_interview 必须提交本书画像、个性化读前简报、用户可读的处理方式和结构化策略。结构化策略要如实产出：整体处理目标 goals、表达原则 expression_principles（说明增强内容如何与原文协作、克制到什么程度）；导读 guide、裁读注 annotations、节后助读 after_reading 三段各自用 enabled 明确决定是否启用——启用时给出对应要点（guide.objectives / annotations.focuses 与 exclusions / after_reading.objectives），认为某段对本书无价值就把该段 enabled 设为 false 并把要点留空，不要为了填满而编造。trial_candidates 从 book profile 候选池中选择恰好三个不同候选，覆盖进入门槛、典型内容和较高难度内容。你没有确认权限，不能批准试读或创建正式策略。`;

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
  // their 1-based block_index) so the agent can pick real block ranges in one turn.
  if (Array.isArray(context.trialNodeContents) && context.trialNodeContents.length > 0) {
    messages.push(userTurnMessage(
      `【候选试读节点正文（用于选片段，block_index 为节点内 1 基编号）】\n${JSON.stringify(context.trialNodeContents, null, 2)}`,
    ));
  }
  return messages;
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
  maxTurns?: number;
  timeoutMs?: number;
  onTrace?: AgentTraceHandler;
  onStream?: (delta: InterviewStreamDelta) => void;
}): Promise<ReadingSetupOutcome> {
  let outcome: ReadingSetupOutcome | undefined;
  let turns = 0;
  let toolCalls = 0;
  let limitExceeded = false;
  const maxTurns = options.maxTurns ?? 8;
  const tools: AgentTool[] = [];

  if (options.phase === 'interviewing') {
    if (options.askedCount < 7) {
      tools.push({
        name: 'present_interview_question',
        label: 'Present interview question',
        description: '信息仍不足时，提交下一道要展示给用户的问题。',
        parameters: InterviewQuestionSchema,
        executionMode: 'sequential',
        execute: async (_id, input) => {
          outcome = { type: 'question', question: input as InterviewQuestion };
          return {
            content: [{ type: 'text' as const, text: 'Interview question accepted.' }],
            details: { questionId: (input as InterviewQuestion).id },
            terminate: true,
          };
        },
      });
    }
    if (options.askedCount > 0) tools.push({
      name: 'finish_interview',
      label: 'Finish interview',
      description: '信息已经足够或问题达到上限时，提交完整的阅读准备结果。',
      parameters: Type.Object({
        book_reader_profile: BookReaderProfileSchema,
        reader_profile_patch: Type.Optional(ReaderProfilePatchSchema),
        briefing: Type.String({ minLength: 100, maxLength: 12000 }),
        public_strategy: Type.String({ minLength: 50, maxLength: 8000 }),
        strategy: ReadingStrategySchema,
      }),
      executionMode: 'sequential',
      execute: async (_id, input) => {
        const value = input as {
          book_reader_profile: BookReaderProfile;
          reader_profile_patch?: ReaderProfilePatch;
          briefing: string;
          public_strategy: string;
          strategy: ReadingStrategy;
        };
        outcome = {
          type: 'completed',
          bookReaderProfile: value.book_reader_profile,
          ...(value.reader_profile_patch ? { readerProfilePatch: value.reader_profile_patch } : {}),
          briefing: value.briefing,
          publicStrategy: value.public_strategy,
          strategy: value.strategy,
        };
        return {
          content: [{ type: 'text' as const, text: 'Reading setup accepted.' }],
          details: { trialCandidateCount: value.strategy.trial_candidates.length },
          terminate: true,
        };
      },
    });
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
        '读过候选节点正文后，选出恰好三个互不重叠、可独立阅读的试读片段，分别覆盖进入门槛(threshold)/典型内容(typical)/较高难度(hardest)；每个片段给出 section_id+segment 与节点内连续 block range，且 range 必须落在该节点已给出的 block 范围内。',
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

  const systemPrompt = options.phase === 'strategy_review'
    ? `${READING_SETUP_SYSTEM_PROMPT}\n当前处于处理方式确认阶段：请结合访谈历史与上一版草稿，吸收用户最新反馈后调用 save_strategy_draft 产出新草稿，保持连续性，不要提出新问题或确认策略。`
    : options.phase === 'select_trial'
      ? `${READING_SETUP_SYSTEM_PROMPT}\n当前处于试读片段选择阶段：处理方式已确认，请依据已给出的候选节点正文，调用 select_trial_fragments 选出恰好三个不重叠、可独立阅读的片段，分别标记 threshold/typical/hardest。只能引用候选节点，range 必须落在对应节点已列出的 block 范围内，优先命中最能体现处理价值的内容，不要提问或改动策略。`
      : READING_SETUP_SYSTEM_PROMPT;
  const prompt = options.phase === 'strategy_review'
    ? `用户对当前处理方式草稿给出以下反馈，请吸收后调用 save_strategy_draft 产出新草稿：\n${options.feedback ?? ''}`
    : options.phase === 'select_trial'
      ? '处理方式已确认。请阅读上面给出的候选试读节点正文，调用 select_trial_fragments 选出恰好三个互不重叠、能独立阅读的片段（threshold/典型/hardest 各一），每个给出 section_id+segment 与落在该节点 block 范围内的连续 range。'
      : `请根据以上长期画像、书籍资料与访谈对话继续本书访谈。已提出 ${options.askedCount} 道问题，最多 7 道。信息不足就用 present_interview_question 提下一题，信息足够或已达上限就 finish_interview。`;
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: createModel(options),
      thinkingLevel: 'medium',
      tools,
      messages: reconstructReadingSetupHistory(options.context, options.modelName),
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
  // Token-level interview streaming (§4): translate the model's streamed tool-call
  // arguments into semantic deltas. Only the interviewing phase presents questions.
  if (options.onStream && options.phase === 'interviewing') {
    const parser = createInterviewStreamParser(options.onStream);
    agent.subscribe((event) => {
      if (event.type !== 'message_update') return;
      const streamed = event.assistantMessageEvent;
      if (streamed.type === 'toolcall_start') {
        const part = streamed.partial.content[streamed.contentIndex];
        parser.onToolStart(part && part.type === 'toolCall' ? part.name : '');
      } else if (streamed.type === 'toolcall_delta') {
        parser.onDelta(streamed.delta);
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
