/** Composes the reading-setup Agent Tool set from focused capability modules. */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  AgentMessageDto,
  AgentRunInput,
  AgentSessionState,
} from '@readtailor/contracts';
import type { Database } from '@readtailor/database';
import type { ModelEngine } from '@readtailor/model';
import type { ObjectStorage } from '@readtailor/storage';
import { createReadingSetupActivationService } from './reading-setup-activation';
import { createReadingSetupBookTools } from './reading-setup-book-tools';
import { createReadingSetupCompletionTool } from './reading-setup-completion-tool';
import { createReadingSetupPresentationTools } from './reading-setup-presentation-tools';
import {
  loadReadingSetupAgentResources,
  type ReadingSetupAgentResources,
} from './reading-setup-resources';
import {
  createReadingSetupToolHistory,
} from './reading-setup-tool-support';
import { createReadingSetupTrialTool } from './reading-setup-trial-tool';

export type { ReadingSetupAgentResources } from './reading-setup-resources';

export function createReadingSetupAgentTools(options: {
  db: Database;
  storage: ObjectStorage;
  tailoringModel: ModelEngine;
  sessionId: string;
  runId: string;
  userBookId: string;
  state: AgentSessionState;
  input: AgentRunInput;
  currentRunMessages?: () => readonly AgentMessageDto[];
}): { tools: AgentTool[] } {
  const history = createReadingSetupToolHistory(() => [
    ...options.state.messages,
    ...(options.currentRunMessages?.() ?? []),
  ]);
  let resourcesPromise: Promise<ReadingSetupAgentResources> | undefined;
  const resources = () =>
    (resourcesPromise ??= loadReadingSetupAgentResources({
      db: options.db,
      storage: options.storage,
      userBookId: options.userBookId,
    }));
  const isStrategyConfirmed = (strategyToolCallId: string) =>
    (
      options.input.type === 'confirmation' &&
      options.input.targetToolName === 'publish_strategy' &&
      options.input.targetToolCallId === strategyToolCallId
    ) ||
    options.state.actions.some(
      (action) =>
        action.type === 'confirmation' &&
        action.targetToolName === 'publish_strategy' &&
        action.targetToolCallId === strategyToolCallId,
    );

  return {
    tools: [
      ...createReadingSetupBookTools({ resources }),
      ...createReadingSetupPresentationTools({ history }),
      createReadingSetupTrialTool({
        history,
        isStrategyConfirmed,
        resources,
        tailoringModel: options.tailoringModel,
      }),
      createReadingSetupCompletionTool({
        history,
        complete: async (toolCallId, trialToolCallId) => {
          const loaded = await resources();
          return createReadingSetupActivationService({
            db: options.db,
            manifest: loaded.manifest,
            sessionId: options.sessionId,
            runId: options.runId,
            state: options.state,
            input: options.input,
          }).complete(toolCallId, trialToolCallId);
        },
      }),
    ],
  };
}
