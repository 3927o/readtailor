/** Verifies committed, optimistic, partial, and Trial source facts at the formal projector boundary. */

import { describe, expect, it } from 'vitest';
import { reduceAgentRunEvent } from '@readtailor/agent-state';
import type {
  AgentRunDisplaySnapshot,
  AgentSessionState,
  SubmitReadingSetupActionRequest,
} from '@readtailor/contracts';
import {
  applyOptimisticReadingSetupAction,
} from './projectTranscript';
import {
  createLiveRunOrder,
  projectLiveReadingSetupTranscript,
  reduceLiveRunOrder,
} from './projectLiveTranscript';
import { projectPersistedReadingSetupTranscript } from './projectPersistedTranscript';
import type { ReadingSetupTranscriptEntry } from './types';

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
  content: unknown[],
  timestamp: number,
): AgentSessionState['messages'][number] {
  return {
    role: 'assistant',
    content,
    api: 'test',
    provider: 'test',
    model: 'test',
    usage,
    stopReason: 'toolUse',
    timestamp,
  } as AgentSessionState['messages'][number];
}

function result(
  toolCallId: string,
  toolName: string,
  details: unknown,
  timestamp: number,
): AgentSessionState['messages'][number] {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text: 'ok' }],
    details,
    isError: false,
    timestamp,
  } as AgentSessionState['messages'][number];
}

describe('formal reading-setup transcript projectors', () => {
  it('uses committed actions for visible user facts and artifact confirmation state', () => {
    const questionArgs = {
      prompt: '你希望怎么读？',
      options: [{ id: 'light', label: '轻一点提醒' }],
      selectionMode: 'single',
      allowFreeText: true,
    };
    const strategy = {
      briefToolCallId: 'brief-1',
      bookReaderProfileToolCallId: 'profile-1',
      summary: '尽量克制',
      strategy: {
        goals: ['理解转向'],
        expressionPrinciples: ['不重复原文'],
        guide: { enabled: true, objectives: ['轻提醒'] },
        annotations: { enabled: true, focuses: ['概念'], exclusions: [] },
        afterReading: { enabled: true, objectives: ['联系自己'] },
      },
    };
    const trialResult = {
      toolCallId: 'trial-1',
      strategyToolCallId: 'strategy-2',
      source: {
        titlePath: ['第一章'],
        sectionId: 'chapter-1',
        segment: 1,
        range: {
          start: { blockIndex: 3, offset: 5 },
          end: { blockIndex: 3, offset: 9 },
        },
        text: '关键段落',
        blocks: [{
          blockIndex: 3,
          kind: 'p',
          text: '关键段落',
          sourceOffset: 5,
        }],
      },
      guide: '先看概念变化。',
      annotations: [{
        range: {
          start: { blockIndex: 3, offset: 7 },
          end: { blockIndex: 3, offset: 9 },
        },
        content: '这里是转向。',
      }],
      afterReading: null,
    };
    const state = {
      systemPrompt: 'test',
      modelConfigId: 'test',
      thinkingLevel: 'off',
      messages: [
        assistant([
          { type: 'text', text: '先问一件事。' },
          { type: 'toolCall', id: 'question-1', name: 'present_question', arguments: questionArgs },
        ], 1_000),
        result('question-1', 'present_question', { toolCallId: 'question-1' }, 1_100),
        {
          role: 'user',
          content: JSON.stringify({
            action: 'question_answer',
            questionToolCallId: 'question-1',
            selectedOptionIds: ['light'],
            freeText: null,
          }),
          timestamp: 2_000,
        },
        assistant([
          { type: 'toolCall', id: 'strategy-1', name: 'publish_strategy', arguments: strategy },
        ], 2_100),
        result('strategy-1', 'publish_strategy', { toolCallId: 'strategy-1' }, 2_200),
        {
          role: 'user',
          content: JSON.stringify({
            action: 'feedback',
            targetToolCallId: 'strategy-1',
            targetToolName: 'publish_strategy',
            message: '再少一点。',
          }),
          timestamp: 3_000,
        },
        assistant([
          {
            type: 'toolCall',
            id: 'strategy-2',
            name: 'publish_strategy',
            arguments: { ...strategy, summary: '只在必要时提醒' },
          },
        ], 3_100),
        result('strategy-2', 'publish_strategy', { toolCallId: 'strategy-2' }, 3_200),
        {
          role: 'user',
          content: JSON.stringify({
            action: 'confirmation',
            targetToolCallId: 'strategy-2',
            targetToolName: 'publish_strategy',
          }),
          timestamp: 4_000,
        },
        assistant([
          {
            type: 'toolCall',
            id: 'trial-1',
            name: 'generate_trial_slice',
            arguments: {
              strategyToolCallId: 'strategy-2',
              sectionId: 'chapter-1',
              segment: 1,
              range: trialResult.source.range,
              reason: '适合验证',
            },
          },
        ], 4_100),
        result('trial-1', 'generate_trial_slice', trialResult, 4_200),
        {
          role: 'user',
          content: JSON.stringify({
            action: 'confirmation',
            targetToolCallId: 'trial-1',
            targetToolName: 'generate_trial_slice',
          }),
          timestamp: 5_000,
        },
      ],
      actions: [
        {
          type: 'question_answer',
          questionToolCallId: 'question-1',
          selectedOptionIds: ['light'],
          freeText: null,
          submittedAt: new Date(2_000).toISOString(),
        },
        {
          type: 'feedback',
          targetToolCallId: 'strategy-1',
          targetToolName: 'publish_strategy',
          message: '再少一点。',
          submittedAt: new Date(3_000).toISOString(),
        },
        {
          type: 'confirmation',
          targetToolCallId: 'strategy-2',
          targetToolName: 'publish_strategy',
          submittedAt: new Date(4_000).toISOString(),
        },
        {
          type: 'confirmation',
          targetToolCallId: 'trial-1',
          targetToolName: 'generate_trial_slice',
          submittedAt: new Date(5_000).toISOString(),
        },
      ],
    } as unknown as AgentSessionState;

    const entries = projectPersistedReadingSetupTranscript(state);

    expect(entries.filter((entry) => entry.kind === 'user').map((entry) => entry.text))
      .toEqual(['轻一点提醒', '再少一点。']);
    expect(entries.some((entry) =>
      entry.kind === 'user' && entry.text.includes('"action"'))).toBe(false);
    expect(entries.find((entry) => entry.id === 'persisted-tool-question-1'))
      .toMatchObject({
        kind: 'question',
        answer: { displayText: '轻一点提醒' },
      });
    expect(entries.find((entry) => entry.id === 'persisted-tool-strategy-1'))
      .toMatchObject({ confirmation: 'superseded' });
    expect(entries.find((entry) => entry.id === 'persisted-tool-strategy-2'))
      .toMatchObject({ confirmation: 'completed' });
    expect(entries.find((entry) => entry.id === 'persisted-tool-trial-1'))
      .toMatchObject({
        confirmation: 'completed',
        paragraphs: [{
          segments: [
            { text: '关键' },
            { text: '段落', annotationId: 'trial-1-annotation-0' },
          ],
        }],
        annotations: [{
          id: 'trial-1-annotation-0',
          label: '段落',
          content: '这里是转向。',
        }],
      });
  });

  it('projects partial Tool arguments and complete execution without inventing workflow state', () => {
    const snapshot: AgentRunDisplaySnapshot = {
      runId: '11111111-1111-4111-8111-111111111111',
      lastSequence: 5,
      status: 'running',
      assistantText: '我再整理一下。',
      assistantMessage: null,
      tools: [
        {
          toolCallId: 'brief-1',
          toolName: 'publish_brief',
          argumentsBuffer: '{"brief":{"bookIdentity":"一本讨论选择的书"',
          arguments: null,
          callFinished: false,
          executionStatus: 'pending',
          result: null,
          isError: false,
        },
        {
          toolCallId: 'query-1',
          toolName: 'search_book',
          argumentsBuffer: '',
          arguments: { query: '选择' },
          callFinished: true,
          executionStatus: 'completed',
          result: {},
          isError: false,
        },
        {
          toolCallId: 'complete-1',
          toolName: 'complete_reading_setup',
          argumentsBuffer: '',
          arguments: { trialToolCallId: 'trial-1' },
          callFinished: true,
          executionStatus: 'running',
          result: null,
          isError: false,
        },
      ],
      error: null,
    };

    const entries = projectLiveReadingSetupTranscript(snapshot);

    expect(entries.find((entry) => entry.id.includes('brief-1'))).toMatchObject({
      kind: 'brief',
      renderState: 'streaming',
      brief: { bookIdentity: '一本讨论选择的书' },
    });
    expect(entries.some((entry) => entry.id.includes('query-1'))).toBe(false);
    expect(entries.find((entry) => entry.id.includes('complete-1'))).toMatchObject({
      kind: 'notice',
      message: '正在把这份读前准备放进正式阅读…',
    });
  });

  it('preserves Assistant and Tool interleaving after the authoritative snapshot', () => {
    let snapshot: AgentRunDisplaySnapshot = {
      runId: '11111111-1111-4111-8111-111111111111',
      lastSequence: 0,
      status: 'running',
      assistantText: '',
      assistantMessage: null,
      tools: [],
      error: null,
    };
    let order = createLiveRunOrder(snapshot);
    const events = [
      {
        type: 'assistant_text_delta',
        runId: snapshot.runId,
        sequence: 1,
        delta: '先说一句。',
      },
      {
        type: 'tool_call_started',
        runId: snapshot.runId,
        sequence: 2,
        toolCallId: 'brief-1',
        toolName: 'publish_brief',
      },
      {
        type: 'assistant_text_delta',
        runId: snapshot.runId,
        sequence: 3,
        delta: '工具后继续。',
      },
    ] as const;
    for (const event of events) {
      snapshot = reduceAgentRunEvent(snapshot, event);
      order = reduceLiveRunOrder(order, event);
    }

    expect(projectLiveReadingSetupTranscript(snapshot, order).map((entry) => entry.kind))
      .toEqual(['assistant', 'brief', 'assistant']);
  });

  it('places an optimistic answer beside its question and reopens the form on failure', () => {
    const persisted: ReadingSetupTranscriptEntry[] = [{
      id: 'question',
      kind: 'question',
      toolCallId: 'question-1',
      renderState: 'ready',
      prompt: '怎么读？',
      options: [{ id: 'light', label: '轻一点' }],
    }];
    const action: SubmitReadingSetupActionRequest = {
      type: 'question_answer',
      questionToolCallId: 'question-1',
      selectedOptionIds: ['light'],
      freeText: null,
    };

    expect(applyOptimisticReadingSetupAction(persisted, {
      id: 'optimistic-1',
      action,
      delivery: 'sending',
    })).toMatchObject([
      { kind: 'question', answer: { displayText: '轻一点' } },
      { kind: 'user', text: '轻一点', delivery: 'sending' },
    ]);
    const failed = applyOptimisticReadingSetupAction(persisted, {
      id: 'optimistic-1',
      action,
      delivery: 'failed',
    });
    expect(failed).toMatchObject([
      { kind: 'question' },
      { kind: 'user', text: '轻一点', delivery: 'failed' },
    ]);
    expect(failed[0]).not.toHaveProperty('answer');
  });
});
