/** Serializes application Agent messages and reconstructs SDK runtime contexts. */

import type {
  AgentContext,
  AgentMessage,
  AgentTool,
} from '@earendil-works/pi-agent-core';
import type {
  AgentAction,
  AgentJsonValue,
  AgentMessageDto,
  AgentSessionState,
  AgentThinkingLevel,
} from '@readtailor/contracts';

export class AgentSessionCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentSessionCodecError';
  }
}

export function toAgentJsonValue(
  value: unknown,
  path = '$',
  seen = new WeakSet<object>(),
): AgentJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object') {
    throw new AgentSessionCodecError(`${path} 包含不可序列化的 ${typeof value}`);
  }
  if (seen.has(value)) throw new AgentSessionCodecError(`${path} 包含循环引用`);
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item, index) => toAgentJsonValue(item, `${path}[${index}]`, seen));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AgentSessionCodecError(`${path} 必须是普通 JSON object`);
  }
  const output: Record<string, AgentJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = toAgentJsonValue(item, `${path}.${key}`, seen);
  }
  return output;
}

function copyOptionalString<T extends string>(value: T | undefined): T | undefined {
  return value === undefined ? undefined : value;
}

export function serializeAgentMessage(message: AgentMessage): AgentMessageDto {
  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      return { role: 'user', content: message.content, timestamp: message.timestamp };
    }
    return {
      role: 'user',
      content: message.content.map((content) => {
        if (content.type !== 'text') {
          throw new AgentSessionCodecError('Agent session 不允许持久化二进制图片内容');
        }
        return {
          type: 'text' as const,
          text: content.text,
          ...(content.textSignature ? { textSignature: content.textSignature } : {}),
        };
      }),
      timestamp: message.timestamp,
    };
  }

  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content.map((content) => {
        if (content.type === 'text') {
          return {
            type: 'text' as const,
            text: content.text,
            ...(content.textSignature ? { textSignature: content.textSignature } : {}),
          };
        }
        if (content.type === 'thinking') {
          return {
            type: 'thinking' as const,
            thinking: content.thinking,
            ...(content.thinkingSignature
              ? { thinkingSignature: content.thinkingSignature }
              : {}),
            ...(content.redacted === undefined ? {} : { redacted: content.redacted }),
          };
        }
        return {
          type: 'toolCall' as const,
          id: content.id,
          name: content.name,
          arguments: toAgentJsonValue(content.arguments, `toolCall(${content.id}).arguments`),
          ...(content.thoughtSignature ? { thoughtSignature: content.thoughtSignature } : {}),
        };
      }),
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...(copyOptionalString(message.responseModel)
        ? { responseModel: message.responseModel }
        : {}),
      ...(copyOptionalString(message.responseId) ? { responseId: message.responseId } : {}),
      ...(message.diagnostics
        ? { diagnostics: toAgentJsonValue(message.diagnostics, 'assistant.diagnostics') as AgentJsonValue[] }
        : {}),
      usage: {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        ...(message.usage.cacheWrite1h === undefined
          ? {}
          : { cacheWrite1h: message.usage.cacheWrite1h }),
        ...(message.usage.reasoning === undefined
          ? {}
          : { reasoning: message.usage.reasoning }),
        totalTokens: message.usage.totalTokens,
        cost: { ...message.usage.cost },
      },
      stopReason: message.stopReason,
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      timestamp: message.timestamp,
    };
  }

  if (message.role === 'toolResult') return {
    role: 'toolResult',
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: message.content.map((content) => {
      if (content.type !== 'text') {
        throw new AgentSessionCodecError('Agent session 不允许持久化二进制 Tool 结果');
      }
      return {
        type: 'text' as const,
        text: content.text,
        ...(content.textSignature ? { textSignature: content.textSignature } : {}),
      };
    }),
    ...(message.details === undefined
      ? {}
      : { details: toAgentJsonValue(message.details, `toolResult(${message.toolCallId}).details`) }),
    isError: message.isError,
    timestamp: message.timestamp,
  };
  throw new AgentSessionCodecError(`Agent session 不支持持久化 ${message.role} 消息`);
}

export function restoreAgentMessages(messages: AgentMessageDto[]): AgentMessage[] {
  // DTO 字段是 SDK 消息的 JSON 子集；clone 可防止运行时改写持久化对象。
  return structuredClone(messages) as AgentMessage[];
}

export function createAgentSessionState(input: {
  systemPrompt: string;
  modelConfigId: string;
  thinkingLevel: AgentThinkingLevel;
  messages?: AgentMessage[];
  actions?: AgentAction[];
}): AgentSessionState {
  return {
    systemPrompt: input.systemPrompt,
    modelConfigId: input.modelConfigId,
    thinkingLevel: input.thinkingLevel,
    messages: (input.messages ?? []).map(serializeAgentMessage),
    actions: structuredClone(input.actions ?? []),
  };
}

export function restoreAgentContext(
  state: AgentSessionState,
  tools: AgentTool[],
): AgentContext {
  return {
    systemPrompt: state.systemPrompt,
    messages: restoreAgentMessages(state.messages),
    tools,
  };
}
