/** Executes generic queued Agent runs and publishes their canonical display progress. */

import {
  createAgentRunProjector,
  createCoalescingAgentEventSink,
} from '@readtailor/agent-kit/runtime';
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
  const eventSink = createCoalescingAgentEventSink({
    sink: (event) => projector.accept(event),
  });
  let startAttempt: Promise<void> | undefined;
  const ensureAttemptStarted = () =>
    (startAttempt ??= projector.startAttempt());

  let outcome: Awaited<ReturnType<typeof handler.execute>> | undefined;
  let handlerFailed = false;
  let handlerError: unknown;
  try {
    outcome = await handler.execute({
      sessionId: options.job.data.sessionId,
      runId: options.job.data.runId,
      input: options.job.data.input,
      emit: async (event) => {
        await ensureAttemptStarted();
        await eventSink.accept(event);
      },
    });
  } catch (error) {
    handlerFailed = true;
    handlerError = error;
  }

  let flushFailed = false;
  let flushError: unknown;
  try {
    await eventSink.flush();
  } catch (error) {
    flushFailed = true;
    flushError = error;
  }

  if (handlerFailed && flushFailed) {
    if (handlerError === flushError) throw handlerError;
    throw new AggregateError(
      [handlerError, flushError],
      'Agent handler 与 progress 发布同时失败',
    );
  }
  if (handlerFailed) throw handlerError;
  if (flushFailed) throw flushError;

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
