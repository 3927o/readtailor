import { and, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { ResolvedModelEndpoint } from '@readtailor/config';
import {
  normalizationRuns,
  sharedBooks,
  sourceUploads,
  type Database,
} from '@readtailor/database';
import { sha256 } from '@readtailor/normalized-book';
import type { PerfSink } from '@readtailor/observability';
import type { ObjectStorage } from '@readtailor/storage';
import { classifyNormalizationFailure, runFormalNormalization } from './coordinator';
import { publishValidatedNormalization } from './publication';

export interface NormalizationExecutionOptions {
  db: Database;
  storage: ObjectStorage;
  normalizationRunId: string;
  repoRoot: string;
  e2bApiKey: string;
  e2bTemplate?: string;
  normalizationModel: ResolvedModelEndpoint;
  analysisModel: ResolvedModelEndpoint;
  maxAttempts: number;
  maxTurns: number;
  attemptTimeoutMs: number;
  analysisMaxTurns: number;
  analysisTimeoutMs: number;
  logger: Logger;
  perfSink?: PerfSink;
}

export async function executeNormalizationRun(options: NormalizationExecutionOptions) {
  const [run] = await options.db
    .select({
      status: normalizationRuns.status,
      bookId: normalizationRuns.sharedBookId,
      sourceObjectKey: sourceUploads.sourceObjectKey,
      epubSha256: sharedBooks.epubSha256,
      currentPackageId: sharedBooks.currentPackageId,
    })
    .from(normalizationRuns)
    .innerJoin(sourceUploads, eq(sourceUploads.id, normalizationRuns.sourceUploadId))
    .innerJoin(sharedBooks, eq(sharedBooks.id, normalizationRuns.sharedBookId))
    .where(eq(normalizationRuns.id, options.normalizationRunId))
    .limit(1);
  if (!run) throw new Error('normalization run not found');
  if (run.status === 'completed') return;
  if (run.status !== 'running') throw new Error(`normalization run is ${run.status}`);
  if (run.currentPackageId) throw new Error('book already points to a published package');

  try {
    const sourceEpub = await options.storage.get(run.sourceObjectKey);
    if (sha256(sourceEpub) !== run.epubSha256) {
      throw new Error('source EPUB failed immutable hash verification');
    }
    await options.db.transaction(async (tx) => {
      await tx
        .update(normalizationRuns)
        .set({ step: 'normalizing', heartbeatAt: sql`now()` })
        .where(
          and(
            eq(normalizationRuns.id, options.normalizationRunId),
            eq(normalizationRuns.status, 'running'),
          ),
        );
      await tx
        .update(sharedBooks)
        .set({ status: 'normalizing', errorSummary: null, updatedAt: sql`now()` })
        .where(and(eq(sharedBooks.id, run.bookId), sql`${sharedBooks.currentPackageId} is null`));
    });

    const candidate = await runFormalNormalization({
      db: options.db,
      storage: options.storage,
      normalizationRunId: options.normalizationRunId,
      sourceEpub,
      repoRoot: options.repoRoot,
      e2bApiKey: options.e2bApiKey,
      ...(options.e2bTemplate ? { e2bTemplate: options.e2bTemplate } : {}),
      modelApiBaseUrl: options.normalizationModel.baseUrl,
      modelApiKey: options.normalizationModel.apiKey,
      modelName: options.normalizationModel.modelName,
      maxAttempts: options.maxAttempts,
      maxTurns: options.maxTurns,
      attemptTimeoutMs: options.attemptTimeoutMs,
      logger: options.logger,
      ...(options.perfSink ? { perfSink: options.perfSink } : {}),
    });
    return await publishValidatedNormalization({
      db: options.db,
      storage: options.storage,
      normalizationRunId: options.normalizationRunId,
      candidate,
      repoRoot: options.repoRoot,
      modelApiBaseUrl: options.analysisModel.baseUrl,
      modelApiKey: options.analysisModel.apiKey,
      analysisModelName: options.analysisModel.modelName,
      analysisMaxTurns: options.analysisMaxTurns,
      analysisTimeoutMs: options.analysisTimeoutMs,
      logger: options.logger,
    });
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    const failureType = classifyNormalizationFailure(error);
    await options.db
      .update(normalizationRuns)
      .set({
        status: 'failed',
        errorSummary: summary.slice(0, 2000),
        failureType,
        completedAt: sql`now()`,
        heartbeatAt: sql`now()`,
      })
      .where(
        and(
          eq(normalizationRuns.id, options.normalizationRunId),
          eq(normalizationRuns.status, 'running'),
        ),
      )
      .catch(() => undefined);
    await options.db
      .update(sharedBooks)
      .set({
        status: 'failed',
        errorSummary: summary.slice(0, 2000),
        failureType,
        updatedAt: sql`now()`,
      })
      .where(and(eq(sharedBooks.id, run.bookId), sql`${sharedBooks.currentPackageId} is null`))
      .catch(() => undefined);
    throw error;
  }
}
