/** Builds a read-only Tool lookup from the canonical persisted Agent message transcript. */

import type {
  AgentJsonValue,
  AgentMessageDto,
} from '@readtailor/contracts';

export type IndexedAgentToolStatus = 'pending' | 'succeeded' | 'failed';

export interface IndexedAgentToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: AgentJsonValue;
  readonly result: AgentJsonValue | undefined;
  readonly status: IndexedAgentToolStatus;
}

export type SuccessfulAgentToolCall = IndexedAgentToolCall & {
  readonly result: AgentJsonValue;
  readonly status: 'succeeded';
};

export interface AgentTranscriptIndex {
  get(toolCallId: string): IndexedAgentToolCall | undefined;
  getSuccessful(toolCallId: string, toolName: string): SuccessfulAgentToolCall | undefined;
  latestSuccessful(toolName: string): SuccessfulAgentToolCall | undefined;
}

export function indexAgentTranscript(
  messages: readonly AgentMessageDto[],
): AgentTranscriptIndex {
  const records = new Map<string, IndexedAgentToolCall>();

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const content of message.content) {
        if (content.type !== 'toolCall') continue;
        records.set(content.id, {
          toolCallId: content.id,
          toolName: content.name,
          arguments: content.arguments,
          result: undefined,
          status: 'pending',
        });
      }
      continue;
    }
    if (message.role !== 'toolResult') continue;
    const record = records.get(message.toolCallId);
    if (!record) continue;
    records.set(message.toolCallId, {
      ...record,
      result: message.details ?? message.content,
      status: message.isError ? 'failed' : 'succeeded',
    });
  }

  const successful = (
    record: IndexedAgentToolCall | undefined,
  ): SuccessfulAgentToolCall | undefined =>
    record?.status === 'succeeded' && record.result !== undefined
      ? record as SuccessfulAgentToolCall
      : undefined;

  return {
    get(toolCallId) {
      return records.get(toolCallId);
    },
    getSuccessful(toolCallId, toolName) {
      const record = records.get(toolCallId);
      return record?.toolName === toolName ? successful(record) : undefined;
    },
    latestSuccessful(toolName) {
      return [...records.values()]
        .reverse()
        .map(successful)
        .find((record) => record?.toolName === toolName);
    },
  };
}
