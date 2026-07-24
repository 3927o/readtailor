/** Executes a reading-setup Agent attempt and keeps its transient Tool transcript attempt-local. */

import type {
  AgentJsonValue,
  AgentMessageDto,
  AgentRunInput,
} from '@readtailor/contracts';
import {
  createReadingSetupSessionStore,
  type Database,
} from '@readtailor/database';
import type { ModelEngine } from '@readtailor/model';
import type { ObjectStorage } from '@readtailor/storage';
import {
  READING_SETUP_AGENT_PROMPT_VERSION,
  runReadingSetupAgentLoop,
} from '@readtailor/agent-kit/reading-setup';
import {
  createOpenAiCompatibleAgentModel,
  serializeAgentMessage,
} from '@readtailor/agent-kit/runtime';
import type { AgentRunHandler } from './registry';
import { createReadingSetupAgentTools } from './reading-setup';

function readingSetupRunInput(value: AgentJsonValue): AgentRunInput {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('reading_setup Agent input 必须是 object');
  }
  if (value.type === 'session_start') {
    return value as AgentRunInput;
  }
  if (value.type === 'message' && typeof value.text === 'string') {
    return value as AgentRunInput;
  }
  if (
    value.type === 'question_answer' &&
    typeof value.questionToolCallId === 'string' &&
    Array.isArray(value.selectedOptionIds) &&
    value.selectedOptionIds.every((item) => typeof item === 'string') &&
    (value.freeText === null || typeof value.freeText === 'string')
  ) {
    return value as AgentRunInput;
  }
  if (
    value.type === 'feedback' &&
    typeof value.targetToolCallId === 'string' &&
    (value.targetToolName === 'publish_strategy' ||
      value.targetToolName === 'generate_trial_slice') &&
    typeof value.message === 'string'
  ) {
    return value as AgentRunInput;
  }
  if (
    value.type === 'confirmation' &&
    typeof value.targetToolCallId === 'string' &&
    (value.targetToolName === 'publish_strategy' ||
      value.targetToolName === 'generate_trial_slice')
  ) {
    return value as AgentRunInput;
  }
  throw new Error('reading_setup Agent input 无效');
}

export function createReadingSetupAgentHandler(options: {
  db: Database;
  storage: ObjectStorage;
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  tailoringModel: ModelEngine;
}): AgentRunHandler {
  const store = createReadingSetupSessionStore({ db: options.db });
  const model = createOpenAiCompatibleAgentModel({
    apiBaseUrl: options.apiBaseUrl,
    modelName: options.modelName,
  });

  return {
    agentType: 'reading_setup',
    async execute(input) {
      const session = await store.getById(input.sessionId);
      if (!session || session.activeRunId !== input.runId) return 'stale';

      const runInput = readingSetupRunInput(input.input);
      const currentRunMessages: AgentMessageDto[] = [];
      const toolbox = createReadingSetupAgentTools({
        db: options.db,
        storage: options.storage,
        tailoringModel: options.tailoringModel,
        sessionId: session.id,
        runId: input.runId,
        userBookId: session.userBookId,
        state: session.agentState,
        input: runInput,
        currentRunMessages: () => currentRunMessages,
      });
      const nextState = await runReadingSetupAgentLoop({
        state: session.agentState,
        input: runInput,
        model,
        apiKey: options.apiKey,
        tools: toolbox.tools,
        emit: async (event) => {
          if (
            event.type === 'message_end' &&
            (event.message.role === 'assistant' || event.message.role === 'toolResult')
          ) {
            currentRunMessages.push(serializeAgentMessage(event.message));
          }
          await input.emit(event);
        },
      });
      const committed = await store.commitRun(session.id, input.runId, nextState);
      return committed ? 'committed' : 'stale';
    },
    async fail(input) {
      const cleared = await store.failRun(input.sessionId, input.runId);
      return cleared ? 'cleared' : 'stale';
    },
  };
}
