/** Composes the reading-setup Agent Tool set from focused capability modules. */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import type {
  AgentMessageDto,
  AgentSessionState,
} from '@readtailor/contracts';
import type { Database } from '@readtailor/database';
import type { ModelEngine } from '@readtailor/model';
import type { ObjectStorage } from '@readtailor/storage';
import { createReadingSetupBookTools } from './reading-setup-book-tools';
import {
  createReadingSetupConfirmationTool,
  createReadingSetupPresentationTools,
} from './reading-setup-presentation-tools';
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

  return {
    tools: [
      ...createReadingSetupBookTools({ resources }),
      ...createReadingSetupPresentationTools(),
      createReadingSetupTrialTool({
        history,
        resources,
        tailoringModel: options.tailoringModel,
      }),
      createReadingSetupConfirmationTool({ history }),
    ],
  };
}
