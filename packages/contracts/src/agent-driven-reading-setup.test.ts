/** Verifies the serializable reading-setup session and generic run event contracts. */

import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AgentRunEventSchema,
  AgentSessionStateSchema,
  type AgentRunEvent,
  type AgentSessionState,
} from './index';

describe('Agent-driven reading setup contracts', () => {
  it('round-trips the complete application DTO without workflow phases or state versions', () => {
    const state: AgentSessionState = {
      systemPrompt: 'system snapshot',
      modelConfigId: 'model:prompt-1',
      thinkingLevel: 'high',
      messages: [
        { role: 'user', content: 'hello', timestamp: 1 },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private reasoning', thinkingSignature: 'sig' },
            { type: 'text', text: 'answer' },
            { type: 'toolCall', id: 'call-1', name: 'read_book_node', arguments: { limit: 3 } },
          ],
          api: 'openai-completions',
          provider: 'test',
          model: 'test-model',
          usage: {
            input: 10,
            output: 5,
            cacheRead: 1,
            cacheWrite: 2,
            reasoning: 2,
            totalTokens: 18,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'toolUse',
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read_book_node',
          content: [{ type: 'text', text: 'done' }],
          details: { blocks: [{ blockIndex: 1, text: 'content' }] },
          isError: false,
          timestamp: 3,
        },
      ],
      actions: [
        {
          type: 'question_answer',
          questionToolCallId: 'question-1',
          selectedOptionIds: ['a'],
          freeText: null,
          submittedAt: '2026-07-22T00:00:00.000Z',
        },
        {
          type: 'strategy_confirmation',
          strategyToolCallId: 'strategy-1',
          submittedAt: '2026-07-23T00:00:00.000Z',
        },
        {
          type: 'trial_confirmation',
          trialToolCallId: 'trial-1',
          submittedAt: '2026-07-24T00:00:00.000Z',
          result: {
            userBookId: '11111111-1111-4111-8111-111111111111',
            workflowStatus: 'active_reading',
            strategyVersionId: '22222222-2222-4222-8222-222222222222',
          },
        },
      ],
    };
    const restored = JSON.parse(JSON.stringify(state)) as AgentSessionState;
    expect(Value.Check(AgentSessionStateSchema, restored)).toBe(true);
    expect(restored).toEqual(state);
    expect(Object.keys(restored)).not.toContain('version');
    expect(JSON.stringify(restored)).not.toContain('phase');
  });

  it('defines exactly the ten generic run event kinds', () => {
    const kinds: AgentRunEvent['type'][] = [
      'run_snapshot',
      'assistant_text_delta',
      'tool_call_started',
      'tool_call_arguments_delta',
      'tool_call_finished',
      'assistant_message_finished',
      'tool_execution_started',
      'tool_execution_progress',
      'tool_execution_finished',
      'run_finished',
    ];
    expect(AgentRunEventSchema.anyOf).toHaveLength(10);
    expect(new Set(kinds).size).toBe(10);
  });
});
