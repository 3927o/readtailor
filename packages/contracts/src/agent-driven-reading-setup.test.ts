/** Verifies the serializable reading-setup session and generic run event contracts. */

import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  AgentRunEventSchema,
  AgentSessionStateSchema,
  CompleteReadingSetupResultSchema,
  GenerateTrialSliceResultSchema,
  SubmitReadingSetupActionRequestSchema,
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
          type: 'feedback',
          targetToolCallId: 'strategy-1',
          targetToolName: 'publish_strategy',
          message: '请增加例子',
          submittedAt: '2026-07-23T00:00:00.000Z',
        },
        {
          type: 'confirmation',
          targetToolCallId: 'trial-1',
          targetToolName: 'generate_trial_slice',
          submittedAt: '2026-07-24T00:00:00.000Z',
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

  it('defines external user actions as a strict discriminated union', () => {
    const actions = [
      { type: 'message', text: '开始准备' },
      {
        type: 'question_answer',
        questionToolCallId: 'question-1',
        selectedOptionIds: ['apply'],
        freeText: null,
      },
      {
        type: 'feedback',
        targetToolCallId: 'strategy-1',
        message: '请增加例子',
      },
      {
        type: 'confirmation',
        targetToolCallId: 'strategy-1',
      },
    ];
    for (const action of actions) {
      expect(Value.Check(SubmitReadingSetupActionRequestSchema, action)).toBe(true);
    }
    expect(Value.Check(SubmitReadingSetupActionRequestSchema, {
      type: 'session_start',
    })).toBe(false);
    expect(Value.Check(SubmitReadingSetupActionRequestSchema, {
      type: 'message',
      message: '旧请求字段',
    })).toBe(false);
  });

  it('defines block-addressable trial results for stable annotation projection', () => {
    expect(Value.Check(GenerateTrialSliceResultSchema, {
      toolCallId: 'trial-1',
      strategyToolCallId: 'strategy-1',
      source: {
        titlePath: ['第一章', '当前小节'],
        sectionId: 'chapter-1',
        segment: 1,
        range: {
          start: { blockIndex: 2, offset: 4 },
          end: { blockIndex: 2, offset: 10 },
        },
        text: '试读原文',
        blocks: [{
          blockIndex: 2,
          kind: 'p',
          text: '试读原文',
          sourceOffset: 4,
        }],
      },
      guide: '先留意概念变化。',
      annotations: [{
        range: {
          start: { blockIndex: 2, offset: 4 },
          end: { blockIndex: 2, offset: 6 },
        },
        content: '这里发生了转向。',
      }],
      afterReading: null,
    })).toBe(true);
  });

  it('separates the completion Tool result from the user confirmation action', () => {
    expect(Value.Check(CompleteReadingSetupResultSchema, {
      toolCallId: 'complete-1',
      trialToolCallId: 'trial-1',
      userBookId: '11111111-1111-4111-8111-111111111111',
      workflowStatus: 'active_reading',
      strategyVersionId: '22222222-2222-4222-8222-222222222222',
    })).toBe(true);
  });
});
