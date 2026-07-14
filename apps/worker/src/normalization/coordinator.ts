import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { NormalizationFailureType } from '@readtailor/contracts';
import { runNormalizationAgent } from '@readtailor/agent-kit';
import {
  normalizationArtifacts,
  type Database,
} from '@readtailor/database';
import {
  sha256,
  validateNormalizedCandidate,
  type HostValidationResult,
} from '@readtailor/normalized-book';
import { timeAgentCall, type PerfSink } from '@readtailor/observability';
import type { ObjectStorage } from '@readtailor/storage';
import { createE2BNormalizationSandbox } from './e2b-sandbox';
import {
  createNormalizationRepository,
  type NormalizationRepository,
} from './repository';
import type {
  NormalizationArtifact,
  NormalizationArtifactSink,
  NormalizationSandboxSession,
} from './sandbox';

export type ValidatedNormalizationCandidate = {
  attemptId: string;
  attemptNo: number;
  directory: string;
  normalizerScript: Uint8Array;
  validation: HostValidationResult;
  cleanup(): Promise<void>;
};

export type NormalizationCoordinatorLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
};

async function putImmutable(
  storage: ObjectStorage,
  key: string,
  bytes: Uint8Array,
  contentType?: string,
): Promise<void> {
  const put = await storage.putIfAbsent(key, bytes, contentType);
  if (!put.created) {
    const existing = await storage.get(key);
    if (sha256(existing) !== sha256(bytes)) {
      throw new Error(`immutable attempt artifact already exists with different content: ${key}`);
    }
  }
}

function artifactExtension(kind: NormalizationArtifact['kind']): string {
  if (kind === 'normalizer_script') return 'py';
  if (kind === 'validation_report' || kind === 'candidate_inventory') return 'json';
  return 'txt';
}

function createArtifactRecorder(options: {
  db: Database;
  storage: ObjectStorage;
  normalizationRunId: string;
  attemptId: string;
  attemptNo: number;
}) {
  const latestKeys = new Map<NormalizationArtifact['kind'], string>();
  const sink: NormalizationArtifactSink = async (artifact) => {
    const revision = String(artifact.revision).padStart(4, '0');
    const key = `normalization/${options.normalizationRunId}/attempts/${options.attemptNo}/${artifact.kind}/${revision}.${artifactExtension(artifact.kind)}`;
    await putImmutable(options.storage, key, artifact.bytes);
    await options.db
      .insert(normalizationArtifacts)
      .values({
        normalizationAttemptId: options.attemptId,
        kind: artifact.kind,
        revision: artifact.revision,
        objectKey: key,
        sha256: sha256(artifact.bytes),
        byteSize: artifact.bytes.byteLength,
        metadata: artifact.metadata ?? {},
      })
      .onConflictDoNothing({
        target: [
          normalizationArtifacts.normalizationAttemptId,
          normalizationArtifacts.kind,
          normalizationArtifacts.revision,
        ],
      });
    const [saved] = await options.db
      .select({ objectKey: normalizationArtifacts.objectKey, sha256: normalizationArtifacts.sha256 })
      .from(normalizationArtifacts)
      .where(eq(normalizationArtifacts.objectKey, key))
      .limit(1);
    if (!saved || saved.sha256 !== sha256(artifact.bytes)) {
      throw new Error(`attempt artifact record conflicts with immutable content: ${key}`);
    }
    latestKeys.set(artifact.kind, key);
  };
  return { sink, latestKeys };
}

export function classifyNormalizationFailure(error: unknown): NormalizationFailureType {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|turn limit|aborted/i.test(message)) return 'timeout';
  if (/nb_check|validation|blocking error|inventory/i.test(message)) return 'validation_failed';
  if (/E2B|sandbox|model|fetch|network/i.test(message)) return 'external_error';
  return 'internal_error';
}

export async function runFormalNormalization(options: {
  db: Database;
  storage: ObjectStorage;
  normalizationRunId: string;
  sourceEpub: Uint8Array;
  repoRoot: string;
  e2bApiKey: string;
  e2bTemplate?: string;
  modelApiBaseUrl: string;
  modelApiKey: string;
  modelName: string;
  maxAttempts?: number;
  maxTurns?: number;
  attemptTimeoutMs?: number;
  logger: NormalizationCoordinatorLogger;
  perfSink?: PerfSink;
  repository?: NormalizationRepository;
  createSandbox?: (input: {
    attemptId: string;
    attemptNo: number;
    artifactSink: NormalizationArtifactSink;
  }) => Promise<NormalizationSandboxSession>;
}): Promise<ValidatedNormalizationCandidate> {
  const repository = options.repository ?? createNormalizationRepository(options.db);
  const maxAttempts = options.maxAttempts ?? 3;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? 30 * 60_000;
  let lastError: unknown;

  for (let localAttempt = 1; localAttempt <= maxAttempts; localAttempt += 1) {
    const sessionId = randomUUID();
    const started = await repository.startAttempt({
      normalizationRunId: options.normalizationRunId,
      sandboxProvider: 'e2b',
      agentSessionId: sessionId,
      agentModel: options.modelName,
      sourceEpubSha256: sha256(options.sourceEpub),
      timeoutMs: attemptTimeoutMs,
    });
    const workspace = await mkdtemp(join(tmpdir(), 'readtailor-formal-normalization-'));
    const immutableSourcePath = join(workspace, 'source.epub');
    await writeFile(immutableSourcePath, options.sourceEpub);
    const recorder = createArtifactRecorder({
      db: options.db,
      storage: options.storage,
      normalizationRunId: options.normalizationRunId,
      attemptId: started.id,
      attemptNo: started.attemptNo,
    });
    let sandbox: NormalizationSandboxSession | undefined;

    try {
      sandbox = options.createSandbox
        ? await options.createSandbox({
            attemptId: started.id,
            attemptNo: started.attemptNo,
            artifactSink: recorder.sink,
          })
        : await createE2BNormalizationSandbox({
            apiKey: options.e2bApiKey,
            sourceEpub: options.sourceEpub,
            repoRoot: options.repoRoot,
            attemptId: started.id,
            ...(options.e2bTemplate ? { template: options.e2bTemplate } : {}),
            timeoutMs: attemptTimeoutMs,
            artifactSink: recorder.sink,
          });
      await repository.attachSandbox(started.id, sandbox.id);
      options.logger.info(
        { attemptId: started.id, attemptNo: started.attemptNo, sandboxId: sandbox.id },
        'normalization attempt started',
      );

      const activeSandbox = sandbox;
      const agent = await timeAgentCall(
        options.perfSink,
        {
          requestId: options.normalizationRunId,
          source: 'worker',
          kind: 'normalization',
          model: options.modelName,
        },
        () => runNormalizationAgent({
          apiBaseUrl: options.modelApiBaseUrl,
          apiKey: options.modelApiKey,
          modelName: options.modelName,
          toolbox: activeSandbox,
          sessionId,
          ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
          timeoutMs: attemptTimeoutMs,
          onEvent: async () => {
            await repository.heartbeat(started.id, options.normalizationRunId);
          },
          onTrace: (event) => {
            options.logger.info(
              { attemptId: started.id, attemptNo: started.attemptNo, agentTrace: event },
              'agent trace',
            );
          },
        }),
        { onSuccess: (result) => ({ turnCount: result.turns }) },
      );
      await repository.recordAgentFinish(started.id, agent.finishBinding, {
        turns: agent.turns,
        toolCalls: agent.toolCalls,
      });
      const agentReportKey = recorder.latestKeys.get('validation_report');
      if (!agentReportKey) throw new Error('agent validation report artifact was not persisted');
      await repository.recordValidation({
        attemptId: started.id,
        phase: 'agent',
        invocationNo: 1,
        binding: agent.finishBinding,
        reportObjectKey: agentReportKey,
        exitCode: agent.finishBinding.warningCount > 0 ? 2 : 0,
      });

      await repository.advanceStep(options.normalizationRunId, 'validating');

      const candidateDirectory = join(workspace, 'candidate');
      await sandbox.downloadOutput(candidateDirectory);
      const normalizerScript = await sandbox.readNormalizer();
      const hostValidation = await validateNormalizedCandidate({
        repoRoot: options.repoRoot,
        sourceEpubPath: immutableSourcePath,
        outputDirectory: candidateDirectory,
        normalizerScript,
        timeoutMs: attemptTimeoutMs,
      });
      if (
        hostValidation.binding.scriptSha256 !== agent.finishBinding.scriptSha256 ||
        hostValidation.binding.sourceEpubSha256 !== agent.finishBinding.sourceEpubSha256 ||
        hostValidation.binding.outputInventorySha256 !==
          agent.finishBinding.outputInventorySha256
      ) {
        throw new Error('worker final validation input does not match the Agent finish binding');
      }

      const candidatePrefix = `normalization/${options.normalizationRunId}/attempts/${started.attemptNo}/candidate`;
      for (const entry of hostValidation.outputInventory.files) {
        const bytes = await readFile(join(candidateDirectory, entry.path));
        await putImmutable(options.storage, `${candidatePrefix}/${entry.path}`, bytes);
      }
      await recorder.sink({
        kind: 'candidate_inventory',
        revision: 1,
        bytes: new TextEncoder().encode(
          `${JSON.stringify(
            {
              ...hostValidation.outputInventory,
              sha256: hostValidation.binding.outputInventorySha256,
              objectPrefix: candidatePrefix,
            },
            null,
            2,
          )}\n`,
        ),
      });

      const hostReportKey = `normalization/${options.normalizationRunId}/attempts/${started.attemptNo}/worker_final/nb_check.json`;
      await putImmutable(options.storage, hostReportKey, hostValidation.reportBytes, 'application/json');
      await repository.recordValidation({
        attemptId: started.id,
        phase: 'worker_final',
        invocationNo: 1,
        binding: hostValidation.binding,
        reportObjectKey: hostReportKey,
        exitCode: hostValidation.exitCode,
      });
      await repository.completeAttempt(started.id, hostValidation.binding);
      await repository.advanceToIndexing(options.normalizationRunId);
      await sandbox.close();

      options.logger.info(
        {
          attemptId: started.id,
          attemptNo: started.attemptNo,
          warnings: hostValidation.binding.warningCount,
        },
        'normalization attempt passed independent worker validation',
      );
      return {
        attemptId: started.id,
        attemptNo: started.attemptNo,
        directory: candidateDirectory,
        normalizerScript,
        validation: hostValidation,
        cleanup: () => rm(workspace, { recursive: true, force: true }),
      };
    } catch (error) {
      lastError = error;
      const summary = error instanceof Error ? error.message : String(error);
      await repository
        .failAttempt(started.id, classifyNormalizationFailure(error), summary)
        .catch(() => undefined);
      await sandbox?.close().catch(() => undefined);
      await rm(workspace, { recursive: true, force: true });
      options.logger.warn(
        { attemptId: started.id, attemptNo: started.attemptNo, error: summary.slice(0, 2000) },
        'normalization attempt failed',
      );
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`normalization failed after ${maxAttempts} attempts`);
}
