import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { NormalizationFinishBinding } from '@readtailor/agent-kit';
import {
  normalizationAttempts,
  normalizationRuns,
  normalizationValidations,
  sharedBooks,
  type Database,
} from '@readtailor/database';

export type StartedNormalizationAttempt = {
  id: string;
  attemptNo: number;
};

export function createNormalizationRepository(db: Database) {
  return {
    async startAttempt(options: {
      normalizationRunId: string;
      sandboxProvider: string;
      agentSessionId: string;
      agentModel: string;
      sourceEpubSha256: string;
      timeoutMs: number;
    }): Promise<StartedNormalizationAttempt> {
      return db.transaction(async (tx) => {
        const [run] = await tx
          .select({ id: normalizationRuns.id, status: normalizationRuns.status })
          .from(normalizationRuns)
          .where(eq(normalizationRuns.id, options.normalizationRunId))
          .limit(1);
        if (!run || run.status !== 'running') {
          throw new Error('normalization run is not active');
        }
        const [active] = await tx
          .select({ id: normalizationAttempts.id })
          .from(normalizationAttempts)
          .where(
            and(
              eq(normalizationAttempts.normalizationRunId, options.normalizationRunId),
              eq(normalizationAttempts.status, 'running'),
            ),
          )
          .limit(1);
        if (active) {
          throw new Error(`normalization run already has an active attempt: ${active.id}`);
        }
        const [next] = await tx
          .select({
            attemptNo: sql<number>`coalesce(max(${normalizationAttempts.attemptNo}), 0) + 1`,
          })
          .from(normalizationAttempts)
          .where(eq(normalizationAttempts.normalizationRunId, options.normalizationRunId));
        const attempt = {
          id: randomUUID(),
          attemptNo: Number(next?.attemptNo ?? 1),
        };
        await tx.insert(normalizationAttempts).values({
          ...attempt,
          normalizationRunId: options.normalizationRunId,
          status: 'running',
          sandboxProvider: options.sandboxProvider,
          agentSessionId: options.agentSessionId,
          agentModel: options.agentModel,
          sourceEpubSha256: options.sourceEpubSha256,
          deadlineAt: new Date(Date.now() + 2 * options.timeoutMs + 10 * 60_000),
        });
        await tx
          .update(normalizationRuns)
          .set({ heartbeatAt: sql`now()` })
          .where(eq(normalizationRuns.id, options.normalizationRunId));
        return attempt;
      });
    },

    async heartbeat(attemptId: string, normalizationRunId: string): Promise<void> {
      await db.transaction(async (tx) => {
        await tx
          .update(normalizationAttempts)
          .set({ heartbeatAt: sql`now()` })
          .where(
            and(
              eq(normalizationAttempts.id, attemptId),
              eq(normalizationAttempts.status, 'running'),
            ),
          );
        await tx
          .update(normalizationRuns)
          .set({ heartbeatAt: sql`now()` })
          .where(
            and(
              eq(normalizationRuns.id, normalizationRunId),
              eq(normalizationRuns.status, 'running'),
            ),
          );
      });
    },

    async attachSandbox(attemptId: string, sandboxId: string): Promise<void> {
      const changed = await db
        .update(normalizationAttempts)
        .set({ sandboxId, heartbeatAt: sql`now()` })
        .where(
          and(
            eq(normalizationAttempts.id, attemptId),
            eq(normalizationAttempts.status, 'running'),
          ),
        )
        .returning({ id: normalizationAttempts.id });
      if (changed.length !== 1) throw new Error('normalization attempt is no longer active');
    },

    async recordAgentFinish(
      attemptId: string,
      binding: NormalizationFinishBinding,
      counters: { turns: number; toolCalls: number },
    ): Promise<void> {
      const changed = await db
        .update(normalizationAttempts)
        .set({
          scriptSha256: binding.scriptSha256,
          outputInventorySha256: binding.outputInventorySha256,
          validatorVersion: binding.validatorVersion,
          validationReportSha256: binding.validationReportSha256,
          blockingErrorCount: binding.blockingErrorCount,
          warningCount: binding.warningCount,
          turnCount: counters.turns,
          toolCallCount: counters.toolCalls,
          heartbeatAt: sql`now()`,
        })
        .where(
          and(
            eq(normalizationAttempts.id, attemptId),
            eq(normalizationAttempts.status, 'running'),
          ),
        )
        .returning({ id: normalizationAttempts.id });
      if (changed.length !== 1) throw new Error('normalization attempt is no longer active');
    },

    async recordValidation(options: {
      attemptId: string;
      phase: 'agent' | 'worker_final' | 'package';
      invocationNo: number;
      binding: NormalizationFinishBinding;
      reportObjectKey: string;
      exitCode: number;
      metrics?: Record<string, unknown>;
    }): Promise<void> {
      await db.insert(normalizationValidations).values({
        normalizationAttemptId: options.attemptId,
        phase: options.phase,
        invocationNo: options.invocationNo,
        validatorVersion: options.binding.validatorVersion,
        scriptSha256: options.binding.scriptSha256,
        outputInventorySha256: options.binding.outputInventorySha256,
        reportSha256: options.binding.validationReportSha256,
        sourceEpubSha256: options.binding.sourceEpubSha256,
        reportObjectKey: options.reportObjectKey,
        exitCode: options.exitCode,
        outcome:
          options.binding.blockingErrorCount > 0
            ? 'failed'
            : options.binding.warningCount > 0
              ? 'passed_with_warnings'
              : 'passed',
        blockingErrorCount: options.binding.blockingErrorCount,
        warningCount: options.binding.warningCount,
        metrics: options.metrics ?? {},
      });
    },

    async completeAttempt(
      attemptId: string,
      hostBinding: NormalizationFinishBinding,
    ): Promise<void> {
      const changed = await db
        .update(normalizationAttempts)
        .set({
          status: 'succeeded',
          hostOutputInventorySha256: hostBinding.outputInventorySha256,
          hostValidatorVersion: hostBinding.validatorVersion,
          hostValidationReportSha256: hostBinding.validationReportSha256,
          blockingErrorCount: hostBinding.blockingErrorCount,
          warningCount: hostBinding.warningCount,
          completedAt: sql`now()`,
          heartbeatAt: sql`now()`,
        })
        .where(
          and(
            eq(normalizationAttempts.id, attemptId),
            eq(normalizationAttempts.status, 'running'),
          ),
        )
        .returning({ id: normalizationAttempts.id });
      if (changed.length !== 1) throw new Error('normalization attempt is no longer active');
    },

    async failAttempt(
      attemptId: string,
      errorClass: string,
      errorSummary: string,
    ): Promise<void> {
      await db
        .update(normalizationAttempts)
        .set({
          status: 'failed',
          errorClass,
          errorSummary: errorSummary.slice(0, 2000),
          completedAt: sql`now()`,
          heartbeatAt: sql`now()`,
        })
        .where(
          and(
            eq(normalizationAttempts.id, attemptId),
            eq(normalizationAttempts.status, 'running'),
          ),
        );
    },

    async advanceToIndexing(normalizationRunId: string): Promise<void> {
      await db.transaction(async (tx) => {
        const [run] = await tx
          .update(normalizationRuns)
          .set({ step: 'indexing', heartbeatAt: sql`now()` })
          .where(
            and(
              eq(normalizationRuns.id, normalizationRunId),
              eq(normalizationRuns.status, 'running'),
            ),
          )
          .returning({ sharedBookId: normalizationRuns.sharedBookId });
        if (!run) throw new Error('normalization run is no longer active');
        await tx
          .update(sharedBooks)
          .set({ status: 'indexing', updatedAt: sql`now()` })
          .where(
            and(
              eq(sharedBooks.id, run.sharedBookId),
              sql`${sharedBooks.currentPackageId} is null`,
            ),
          );
      });
    },

    async advanceStep(
      normalizationRunId: string,
      step: 'validating' | 'indexing' | 'analyzing' | 'publishing',
    ): Promise<void> {
      await db.transaction(async (tx) => {
        const [changed] = await tx
          .update(normalizationRuns)
          .set({ step, heartbeatAt: sql`now()` })
          .where(
            and(
              eq(normalizationRuns.id, normalizationRunId),
              eq(normalizationRuns.status, 'running'),
            ),
          )
          .returning({ sharedBookId: normalizationRuns.sharedBookId });
        if (!changed) throw new Error('normalization run is no longer active');
        const status =
          step === 'validating'
            ? 'validating'
            : step === 'indexing'
              ? 'indexing'
              : 'analyzing';
        await tx
          .update(sharedBooks)
          .set({ status, updatedAt: sql`now()` })
          .where(
            and(
              eq(sharedBooks.id, changed.sharedBookId),
              sql`${sharedBooks.currentPackageId} is null`,
            ),
          );
      });
    },
  };
}

export type NormalizationRepository = ReturnType<typeof createNormalizationRepository>;
