/** Maps Pi SDK events into project events and publishes their canonical display projection. */

import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { reduceAgentRunEvent } from '@readtailor/agent-state';
import {
  AGENT_TOOL_ARGUMENTS_MAX_BYTES,
  AGENT_TOOL_RESULT_MAX_BYTES,
  type AgentRunDisplaySnapshot,
  type AgentRunJobPayload,
  type AgentSequencedRunEvent,
} from '@readtailor/contracts';
import { serializeAgentMessage, toAgentJsonValue } from './session';

type AgentSequencedRunEventInput<T = AgentSequencedRunEvent> = T extends unknown
  ? Omit<T, 'runId' | 'sequence'>
  : never;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function createAgentRunProjector(options: {
  runId: AgentRunJobPayload['runId'];
  initialSnapshot?: AgentRunDisplaySnapshot;
  publish: (progress: {
    snapshot: AgentRunDisplaySnapshot;
    event: AgentSequencedRunEvent | null;
  }) => Promise<void>;
}) {
  let snapshot: AgentRunDisplaySnapshot = options.initialSnapshot ?? {
    runId: options.runId,
    lastSequence: 0,
    status: 'queued',
    assistantText: '',
    assistantMessage: null,
    tools: [],
    error: null,
  };

  const publish = async (event: AgentSequencedRunEvent | null) => {
    await options.publish({ snapshot: structuredClone(snapshot), event });
  };

  const event = async (
    value: AgentSequencedRunEventInput,
  ): Promise<void> => {
    const sequenced = {
      ...value,
      runId: options.runId,
      sequence: snapshot.lastSequence + 1,
    } as AgentSequencedRunEvent;
    snapshot = reduceAgentRunEvent(snapshot, sequenced);
    await publish(sequenced);
  };

  return {
    get snapshot(): AgentRunDisplaySnapshot {
      return structuredClone(snapshot);
    },

    async startAttempt(): Promise<void> {
      snapshot = {
        runId: options.runId,
        lastSequence: snapshot.lastSequence,
        status: 'running',
        assistantText: '',
        assistantMessage: null,
        tools: [],
        error: null,
      };
      await publish(null);
    },

    async accept(sdkEvent: AgentEvent): Promise<void> {
      if (sdkEvent.type === 'message_update' && sdkEvent.message.role === 'assistant') {
        const update = sdkEvent.assistantMessageEvent;
        if (update.type === 'text_delta') {
          await event({ type: 'assistant_text_delta', delta: update.delta });
          return;
        }
        if (update.type === 'toolcall_start') {
          const content = update.partial.content[update.contentIndex];
          if (content?.type !== 'toolCall') return;
          await event({
            type: 'tool_call_started',
            toolCallId: content.id,
            toolName: content.name,
          });
          return;
        }
        if (update.type === 'toolcall_delta') {
          const content = update.partial.content[update.contentIndex];
          if (content?.type !== 'toolCall') return;
          const existing = snapshot.tools.find((item) => item.toolCallId === content.id);
          const argumentsBuffer = `${existing?.argumentsBuffer ?? ''}${update.delta}`;
          if (Buffer.byteLength(argumentsBuffer, 'utf8') > AGENT_TOOL_ARGUMENTS_MAX_BYTES) {
            throw new Error(
              `Tool ${content.name} arguments 超过 ${AGENT_TOOL_ARGUMENTS_MAX_BYTES} bytes 上限`,
            );
          }
          await event({
            type: 'tool_call_arguments_delta',
            toolCallId: content.id,
            delta: update.delta,
          });
          return;
        }
        if (update.type === 'toolcall_end') {
          const argumentsValue = toAgentJsonValue(update.toolCall.arguments);
          if (jsonBytes(argumentsValue) > AGENT_TOOL_ARGUMENTS_MAX_BYTES) {
            throw new Error(
              `Tool ${update.toolCall.name} arguments 超过 ${AGENT_TOOL_ARGUMENTS_MAX_BYTES} bytes 上限`,
            );
          }
          await event({
            type: 'tool_call_finished',
            toolCallId: update.toolCall.id,
            toolName: update.toolCall.name,
            arguments: argumentsValue,
          });
        }
        return;
      }

      if (sdkEvent.type === 'message_end' && sdkEvent.message.role === 'assistant') {
        const message = serializeAgentMessage(sdkEvent.message);
        if (message.role !== 'assistant') return;
        await event({ type: 'assistant_message_finished', message });
        return;
      }

      if (sdkEvent.type === 'tool_execution_start') {
        await event({
          type: 'tool_execution_started',
          toolCallId: sdkEvent.toolCallId,
          toolName: sdkEvent.toolName,
        });
        return;
      }

      if (sdkEvent.type === 'tool_execution_update') {
        const progress = toAgentJsonValue(sdkEvent.partialResult);
        if (jsonBytes(progress) > AGENT_TOOL_RESULT_MAX_BYTES) {
          throw new Error(
            `Tool ${sdkEvent.toolName} progress 超过 ${AGENT_TOOL_RESULT_MAX_BYTES} bytes 上限`,
          );
        }
        await event({
          type: 'tool_execution_progress',
          toolCallId: sdkEvent.toolCallId,
          progress,
        });
        return;
      }

      if (sdkEvent.type === 'tool_execution_end') {
        const result = toAgentJsonValue(sdkEvent.result);
        if (jsonBytes(result) > AGENT_TOOL_RESULT_MAX_BYTES) {
          throw new Error(
            `Tool ${sdkEvent.toolName} result 超过 ${AGENT_TOOL_RESULT_MAX_BYTES} bytes 上限`,
          );
        }
        await event({
          type: 'tool_execution_finished',
          toolCallId: sdkEvent.toolCallId,
          result,
          isError: sdkEvent.isError,
        });
      }
    },

    async completed(): Promise<void> {
      await event({ type: 'run_finished', status: 'completed' });
    },

    async failed(error: string): Promise<void> {
      await event({ type: 'run_finished', status: 'failed', error });
    },
  };
}

export type AgentRunProjector = ReturnType<typeof createAgentRunProjector>;
