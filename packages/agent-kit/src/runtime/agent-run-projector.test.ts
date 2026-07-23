/** Verifies SDK event mapping, canonical projection parity, retries, and payload limits. */

import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { reduceAgentRunEvent } from '@readtailor/agent-state';
import {
  AGENT_TOOL_ARGUMENTS_MAX_BYTES,
  type AgentRunDisplaySnapshot,
  type AgentSequencedRunEvent,
} from '@readtailor/contracts';
import { createAgentRunProjector } from './agent-run-projector';

const runId = '00000000-0000-0000-0000-000000000001';

describe('Agent run projector', () => {
  it('projects SDK lifecycle events into monotonic generic snapshots', async () => {
    const published: Array<{
      snapshot: AgentRunDisplaySnapshot;
      event: AgentSequencedRunEvent | null;
    }> = [];
    const projector = createAgentRunProjector({
      runId,
      publish: async (progress) => {
        published.push(progress);
      },
    });
    await projector.startAttempt();
    await projector.accept({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', delta: '正在准备' },
    } as unknown as AgentEvent);
    await projector.accept({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        partial: {
          content: [{ type: 'toolCall', id: 'tool-1', name: 'publish_brief', arguments: {} }],
        },
      },
    } as unknown as AgentEvent);
    await projector.accept({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: {
        type: 'toolcall_delta',
        contentIndex: 0,
        delta: '{"brief":{}}',
        partial: {
          content: [{ type: 'toolCall', id: 'tool-1', name: 'publish_brief', arguments: {} }],
        },
      },
    } as unknown as AgentEvent);
    await projector.accept({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: {
        type: 'toolcall_end',
        toolCall: { id: 'tool-1', name: 'publish_brief', arguments: { brief: {} } },
      },
    } as unknown as AgentEvent);
    await projector.accept({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'publish_brief',
      args: { brief: {} },
    } as unknown as AgentEvent);
    await projector.accept({
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      toolName: 'publish_brief',
      args: { brief: {} },
      partialResult: { stage: 'validating' },
    } as unknown as AgentEvent);
    await projector.accept({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'publish_brief',
      result: { content: [{ type: 'text', text: 'ok' }], details: { toolCallId: 'tool-1' } },
      isError: false,
    } as unknown as AgentEvent);
    await projector.completed();

    expect(published[0]).toMatchObject({
      event: null,
      snapshot: { lastSequence: 0, status: 'running' },
    });
    const events = published.flatMap((item) => (item.event ? [item.event] : []));
    expect(events.map((event) => event.type)).toEqual([
      'assistant_text_delta',
      'tool_call_started',
      'tool_call_arguments_delta',
      'tool_call_finished',
      'tool_execution_started',
      'tool_execution_progress',
      'tool_execution_finished',
      'run_finished',
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    let replayed = published[0]!.snapshot;
    for (const progress of published.slice(1)) {
      if (progress.event) replayed = reduceAgentRunEvent(replayed, progress.event);
      expect(progress.snapshot).toEqual(replayed);
    }
    expect(projector.snapshot).toMatchObject({
      status: 'completed',
      assistantText: '正在准备',
      lastSequence: 8,
      tools: [
        {
          toolCallId: 'tool-1',
          toolName: 'publish_brief',
          callFinished: true,
          executionStatus: 'completed',
          isError: false,
        },
      ],
    });
  });

  it('keeps sequence monotonic across a retry and resets partial display state', async () => {
    const published: Array<{
      snapshot: AgentRunDisplaySnapshot;
      event: AgentSequencedRunEvent | null;
    }> = [];
    const projector = createAgentRunProjector({
      runId,
      initialSnapshot: {
        runId,
        lastSequence: 9,
        status: 'failed',
        assistantText: 'stale partial text',
        assistantMessage: null,
        tools: [],
        error: 'temporary failure',
      },
      publish: async (progress) => {
        published.push(progress);
      },
    });

    await projector.startAttempt();
    await projector.failed('terminal failure');

    expect(published[0]?.snapshot).toMatchObject({
      lastSequence: 9,
      status: 'running',
      assistantText: '',
      error: null,
    });
    expect(published[1]?.event).toMatchObject({
      type: 'run_finished',
      sequence: 10,
      status: 'failed',
      error: 'terminal failure',
    });
  });

  it('rejects oversized progressive tool arguments', async () => {
    const projector = createAgentRunProjector({ runId, publish: async () => undefined });
    await expect(
      projector.accept({
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'toolcall_delta',
          contentIndex: 0,
          delta: 'x'.repeat(AGENT_TOOL_ARGUMENTS_MAX_BYTES + 1),
          partial: {
            content: [{ type: 'toolCall', id: 'tool-1', name: 'unsafe', arguments: {} }],
          },
        },
      } as unknown as AgentEvent),
    ).rejects.toThrow('arguments 超过');
  });
});
