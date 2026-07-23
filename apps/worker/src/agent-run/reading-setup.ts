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
import { createReadingSetupBookTools } from './reading-setup-book-tools';
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
      options.input.type === 'strategy_confirmation' &&
      options.input.strategyToolCallId === strategyToolCallId
    ) ||
    options.state.actions.some(
      (action) =>
        action.type === 'strategy_confirmation' &&
        action.strategyToolCallId === strategyToolCallId,
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
    ],
  };
}
