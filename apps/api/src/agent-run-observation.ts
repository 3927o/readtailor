/** Provides generic run snapshot lookup and gap-free event subscription over a queue observer. */

import type {
  AgentRunDisplaySnapshot,
  AgentRunEvent,
} from '@readtailor/contracts';
import type {
  AgentRunJobProgress,
  AgentRunObserver,
} from '@readtailor/queue';

function runSnapshot(runId: string, progress: AgentRunJobProgress | null): AgentRunDisplaySnapshot {
  return progress?.snapshot ?? {
    runId,
    lastSequence: 0,
    status: 'queued',
    assistantText: '',
    assistantMessage: null,
    tools: [],
    error: null,
  };
}

export function createAgentRunObservation(options: {
  observer: AgentRunObserver;
  authorizeSession(userId: string, sessionId: string): Promise<void>;
  runNotFound(): Error;
}) {
  const requireRun = async (sessionId: string, runId: string) => {
    const run = await options.observer.getRun(runId);
    if (!run || run.payload.sessionId !== sessionId) throw options.runNotFound();
    return run;
  };

  return {
    async getSnapshot(
      userId: string,
      sessionId: string,
      runId: string,
    ): Promise<AgentRunDisplaySnapshot> {
      await options.authorizeSession(userId, sessionId);
      const run = await requireRun(sessionId, runId);
      return runSnapshot(runId, run.progress);
    },

    async *subscribe(
      userId: string,
      sessionId: string,
      runId: string,
    ): AsyncGenerator<AgentRunEvent> {
      await options.authorizeSession(userId, sessionId);
      const buffered: AgentRunJobProgress[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = options.observer.subscribe(runId, (progress) => {
        buffered.push(progress);
        wake?.();
        wake = undefined;
      });
      try {
        const run = await requireRun(sessionId, runId);
        const authoritative = runSnapshot(runId, run.progress);
        let lastSequence = authoritative.lastSequence;
        yield { type: 'run_snapshot', runId, snapshot: authoritative };
        if (authoritative.status === 'completed' || authoritative.status === 'failed') return;

        for (;;) {
          const pending = buffered.splice(0).sort(
            (left, right) =>
              (left.event?.sequence ?? left.snapshot.lastSequence) -
              (right.event?.sequence ?? right.snapshot.lastSequence),
          );
          for (const progress of pending) {
            const next = progress.event;
            if (!next) {
              if (progress.snapshot.lastSequence < lastSequence) continue;
              lastSequence = progress.snapshot.lastSequence;
              yield { type: 'run_snapshot', runId, snapshot: progress.snapshot };
              if (
                progress.snapshot.status === 'completed' ||
                progress.snapshot.status === 'failed'
              ) return;
              continue;
            }
            if (next.sequence <= lastSequence) continue;
            lastSequence = next.sequence;
            yield next;
            if (next.type === 'run_finished') return;
          }
          if (buffered.length > 0) continue;
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (buffered.length > 0) {
              wake = undefined;
              resolve();
            }
          });
        }
      } finally {
        unsubscribe();
      }
    },
  };
}
