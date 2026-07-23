/** Verifies deterministic replay of project Agent run events into display snapshots. */

import { describe, expect, it } from 'vitest';
import type { AgentRunDisplaySnapshot, AgentRunEvent } from '@readtailor/contracts';
import { reduceAgentRunEvent } from './run-reducer';

const runId = '11111111-1111-4111-8111-111111111111';

function snapshot(overrides: Partial<AgentRunDisplaySnapshot> = {}): AgentRunDisplaySnapshot {
  return {
    runId,
    lastSequence: 0,
    status: 'running',
    assistantText: '',
    assistantMessage: null,
    tools: [],
    error: null,
    ...overrides,
  };
}

describe('Agent run reducer', () => {
  it('merges assistant, arguments and execution streams by run/tool/sequence', () => {
    const events: AgentRunEvent[] = [
      { type: 'assistant_text_delta', runId, sequence: 1, delta: '你好' },
      { type: 'tool_call_started', runId, sequence: 2, toolCallId: 'brief-1', toolName: 'publish_brief' },
      { type: 'tool_call_arguments_delta', runId, sequence: 3, toolCallId: 'brief-1', delta: '{"brief":' },
      { type: 'tool_call_finished', runId, sequence: 4, toolCallId: 'brief-1', toolName: 'publish_brief', arguments: { brief: { bookIdentity: '书' } } },
      { type: 'tool_execution_started', runId, sequence: 5, toolCallId: 'brief-1', toolName: 'publish_brief' },
      { type: 'tool_execution_finished', runId, sequence: 6, toolCallId: 'brief-1', result: { toolCallId: 'brief-1' }, isError: false },
      { type: 'tool_call_started', runId, sequence: 7, toolCallId: 'future-1', toolName: 'future_tool' },
      { type: 'run_finished', runId, sequence: 8, status: 'completed' },
    ];
    const result = events.reduce<AgentRunDisplaySnapshot | null>(reduceAgentRunEvent, null);
    expect(result).toMatchObject({
      assistantText: '你好',
      lastSequence: 8,
      status: 'completed',
      tools: [
        {
          toolCallId: 'brief-1',
          arguments: { brief: { bookIdentity: '书' } },
          executionStatus: 'completed',
          isError: false,
        },
        { toolCallId: 'future-1', toolName: 'future_tool' },
      ],
    });
    expect(reduceAgentRunEvent(result, events[0]!)).toBe(result);
  });

  it('replaces speculative local state with the authoritative run snapshot', () => {
    const local = snapshot({
      lastSequence: 10,
      assistantText: '错误临时内容',
      tools: [{
        toolCallId: 'old',
        toolName: 'old',
        argumentsBuffer: 'bad',
        arguments: null,
        callFinished: false,
        executionStatus: 'running',
        result: null,
        isError: false,
      }],
    });
    const authority = snapshot({ lastSequence: 4, assistantText: '权威内容', tools: [] });
    const replaced = reduceAgentRunEvent(local, {
      type: 'run_snapshot',
      runId,
      snapshot: authority,
    });
    expect(replaced).toEqual(authority);
    expect(replaced).not.toBe(authority);
  });
});
