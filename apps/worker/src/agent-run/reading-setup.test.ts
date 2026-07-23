/** Verifies reading-setup Tool contracts and explicit cross-Tool references. */

import { describe, expect, it } from 'vitest';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  AgentJsonValue,
  AgentMessageDto,
  AgentSessionState,
  BookReaderProfile,
  Briefing,
  ProposedStrategy,
} from '@readtailor/contracts';
import type { Database } from '@readtailor/database';
import type { ModelEngine } from '@readtailor/model';
import type { ObjectStorage } from '@readtailor/storage';
import { createReadingSetupAgentTools } from './reading-setup';

const brief: Briefing = {
  bookIdentity: '测试书籍',
  arc: '从原理到实践',
  assumedKnowledge: '无',
  readingAdvice: '先理解结构',
};

const profile: BookReaderProfile = {
  purpose: '掌握方法',
  existingKnowledge: [],
  desiredDepthOrOutcome: '能够应用',
  likelyObstacles: ['术语'],
  expectedCommitment: '每天半小时',
  otherConclusions: [],
};

const strategy: ProposedStrategy = {
  goals: ['掌握主线'],
  expressionPrinciples: ['简洁'],
  guide: { enabled: true, objectives: ['建立方向'] },
  annotations: { enabled: true, focuses: ['术语'], exclusions: [] },
  afterReading: { enabled: true, objectives: ['回顾要点'] },
};

function state(options?: {
  trialStrategyToolCallId?: string;
  omitStrategyResult?: boolean;
}): AgentSessionState {
  const calls = [
    { id: 'brief-call', name: 'publish_brief', arguments: { brief } },
    {
      id: 'profile-call',
      name: 'publish_book_reader_profile',
      arguments: { profile },
    },
    {
      id: 'strategy-call',
      name: 'publish_strategy',
      arguments: { summary: '测试策略', strategy },
    },
    {
      id: 'trial-call',
      name: 'generate_trial_slice',
      arguments: {
        strategyToolCallId: 'strategy-call',
        sectionId: 'chapter-1',
        segment: 1,
        range: {
          start: { blockIndex: 1, offset: 0 },
          end: { blockIndex: 1, offset: 10 },
        },
        reason: '测试',
      },
    },
  ];
  const results = calls
    .filter((call) => !(options?.omitStrategyResult && call.name === 'publish_strategy'))
    .map((call) => ({
      role: 'toolResult' as const,
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text' as const, text: 'ok' }],
      details:
        call.name === 'generate_trial_slice'
          ? {
              strategyToolCallId: options?.trialStrategyToolCallId ?? 'strategy-call',
              source: { sectionId: 'chapter-1', segment: 1 },
            }
          : { toolCallId: call.id },
      isError: false,
      timestamp: 2,
    }));
  return {
    systemPrompt: 'system',
    modelConfigId: 'model:prompt',
    thinkingLevel: 'medium',
    messages: [
      {
        role: 'assistant',
        content: calls.map((call) => ({ type: 'toolCall' as const, ...call })),
        api: 'openai-completions',
        provider: 'test',
        model: 'test',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        timestamp: 1,
      },
      ...results,
    ],
    actions: [],
  };
}

function tools(
  sessionState = state(),
  currentRunMessages?: () => readonly AgentMessageDto[],
): AgentTool[] {
  const forbiddenInfrastructure = new Proxy(
    {},
    {
      get() {
        throw new Error('pure tool attempted an infrastructure read');
      },
    },
  );
  return createReadingSetupAgentTools({
    db: forbiddenInfrastructure as Database,
    storage: forbiddenInfrastructure as ObjectStorage,
    tailoringModel: { name: 'fake' } as ModelEngine,
    userBookId: '00000000-0000-0000-0000-000000000001',
    state: sessionState,
    ...(currentRunMessages ? { currentRunMessages } : {}),
  }).tools;
}

function toolByName(all: AgentTool[], name: string): AgentTool {
  const tool = all.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

async function execute(
  tool: AgentTool,
  toolCallId: string,
  input: Record<string, unknown>,
) {
  return (tool.execute as unknown as (
    id: string,
    argumentsValue: Record<string, unknown>,
  ) => Promise<{ details: AgentJsonValue }>)(toolCallId, input);
}

describe('reading setup Agent tools', () => {
  it('exposes bounded read schemas and keeps outline/node-list responses metadata-only', () => {
    const all = tools();
    const outline = toolByName(all, 'get_book_outline').parameters as unknown as {
      properties: { limit: { anyOf?: Array<{ maximum?: number }>; maximum?: number } };
    };
    const nodes = toolByName(all, 'list_reading_nodes').parameters as unknown as {
      properties: { limit: { anyOf?: Array<{ maximum?: number }>; maximum?: number } };
    };
    const read = toolByName(all, 'read_book_node').parameters as unknown as {
      properties: { maxCharacters: { anyOf?: Array<{ maximum?: number }>; maximum?: number } };
    };
    const search = toolByName(all, 'search_book').parameters as unknown as {
      properties: { limit: { anyOf?: Array<{ maximum?: number }>; maximum?: number } };
    };
    const maximum = (schema: { anyOf?: Array<{ maximum?: number }>; maximum?: number }) =>
      schema.maximum ?? schema.anyOf?.find((item) => item.maximum !== undefined)?.maximum;

    expect(maximum(outline.properties.limit)).toBe(200);
    expect(maximum(nodes.properties.limit)).toBe(200);
    expect(maximum(read.properties.maxCharacters)).toBe(12_000);
    expect(maximum(search.properties.limit)).toBe(50);
    expect(toolByName(all, 'get_book_outline').description).toContain('不返回 reading nodes 或正文');
    expect(toolByName(all, 'list_reading_nodes').description).toContain('不返回正文');
  });

  it('runs question and publish tools as pure operations with their own call references', async () => {
    const all = tools();
    const question = await execute(toolByName(all, 'present_question'), 'question-call', {
      prompt: '你最想获得什么？',
      options: [{ id: 'apply', label: '实际应用' }],
      selectionMode: 'single',
      allowFreeText: true,
    });
    const publishedBrief = await execute(toolByName(all, 'publish_brief'), 'new-brief-call', {
      brief,
    });
    const publishedProfile = await execute(
      toolByName(all, 'publish_book_reader_profile'),
      'new-profile-call',
      { profile },
    );
    const publishedStrategy = await execute(
      toolByName(all, 'publish_strategy'),
      'new-strategy-call',
      { summary: '测试策略', strategy },
    );

    expect(question.details).toMatchObject({ toolCallId: 'question-call' });
    expect(publishedBrief.details).toMatchObject({ toolCallId: 'new-brief-call', brief });
    expect(publishedProfile.details).toMatchObject({
      toolCallId: 'new-profile-call',
      profile,
    });
    expect(publishedStrategy.details).toMatchObject({
      toolCallId: 'new-strategy-call',
      strategy,
    });
  });

  it('requires explicit successful references and enforces trial/strategy consistency', async () => {
    const offerInput = {
      briefToolCallId: 'brief-call',
      bookReaderProfileToolCallId: 'profile-call',
      strategyToolCallId: 'strategy-call',
      trialToolCallId: 'trial-call',
      summary: '确认方案',
    };
    const valid = await execute(
      toolByName(tools(), 'offer_final_confirmation'),
      'offer-call',
      offerInput,
    );
    expect(valid.details).toMatchObject({ toolCallId: 'offer-call', ...offerInput });

    const currentAttemptState = state();
    const committedState = { ...currentAttemptState, messages: [] };
    const validFromCurrentAttempt = await execute(
      toolByName(
        tools(committedState, () => currentAttemptState.messages),
        'offer_final_confirmation',
      ),
      'offer-call-current-attempt',
      offerInput,
    );
    expect(validFromCurrentAttempt.details).toMatchObject({
      toolCallId: 'offer-call-current-attempt',
      ...offerInput,
    });

    await expect(
      execute(
        toolByName(tools(state({ trialStrategyToolCallId: 'older-strategy' })), 'offer_final_confirmation'),
        'offer-call',
        offerInput,
      ),
    ).rejects.toThrow('最终确认 strategy 不一致');

    await expect(
      execute(
        toolByName(tools(state({ omitStrategyResult: true })), 'generate_trial_slice'),
        'trial-call-2',
        {
          strategyToolCallId: 'strategy-call',
          sectionId: 'chapter-1',
          segment: 1,
          range: {
            start: { blockIndex: 1, offset: 0 },
            end: { blockIndex: 1, offset: 10 },
          },
          reason: '测试',
        },
      ),
    ).rejects.toThrow('成功的 publish_strategy');
  });
});
