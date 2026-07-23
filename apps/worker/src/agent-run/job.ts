/** Executes generic queued Agent runs and publishes their canonical display progress. */

import { createAgentRunProjector } from '@readtailor/agent-kit/runtime';
import type { AgentRunQueueJob, AgentRunJobProgress } from '@readtailor/queue';
import type { AgentRunDisplaySnapshot } from '@readtailor/contracts';
import type { AgentHandlerRegistry } from './registry';

function currentSnapshot(job: AgentRunQueueJob): AgentRunDisplaySnapshot | undefined {
  if (!job.progress || typeof job.progress !== 'object') return undefined;
  return (job.progress as Partial<AgentRunJobProgress>).snapshot;
}

export async function executeAgentRun(options: {
  registry: AgentHandlerRegistry;
  job: AgentRunQueueJob;
}): Promise<void> {
  const handler = options.registry.require(options.job.data.agentType);
  const snapshot = currentSnapshot(options.job);
  const projector = createAgentRunProjector({
    runId: options.job.data.runId,
    ...(snapshot ? { initialSnapshot: snapshot } : {}),
    publish: (progress) => options.job.updateProgress(progress),
  });
  let startAttempt: Promise<void> | undefined;
  const ensureAttemptStarted = () =>
    (startAttempt ??= projector.startAttempt());

  const outcome = await handler.execute({
    sessionId: options.job.data.sessionId,
    runId: options.job.data.runId,
    input: options.job.data.input,
    emit: async (event) => {
      await ensureAttemptStarted();
      await projector.accept(event);
    },
  });
  if (outcome !== 'committed') return;
  await ensureAttemptStarted();
  await projector.completed();
}

export async function failAgentRun(options: {
  registry: AgentHandlerRegistry;
  job: AgentRunQueueJob;
  error: Error;
}): Promise<void> {
  const handler = options.registry.require(options.job.data.agentType);
  const outcome = await handler.fail({
    sessionId: options.job.data.sessionId,
    runId: options.job.data.runId,
    error: options.error,
  });
  if (outcome !== 'cleared') return;
  const snapshot = currentSnapshot(options.job);
  const projector = createAgentRunProjector({
    runId: options.job.data.runId,
    ...(snapshot ? { initialSnapshot: snapshot } : {}),
    publish: (progress) => options.job.updateProgress(progress),
  });
  await projector.failed(options.error.message.slice(0, 1000));
}
