import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import type { NormalizationFinishBinding } from '@readtailor/agent-kit';
import {
  bookPackages,
  bookProfiles,
  normalizationAttempts,
  normalizationRuns,
  sharedBooks,
  sourceUploads,
  type Database,
} from '@readtailor/database';
import {
  buildArtifactInventory,
  assertSafeRelativePath,
  hashArtifactInventory,
  publishImmutablePackage,
  readBookMetadata,
  runCommand,
  sha256,
} from '@readtailor/normalized-book';
import type { ObjectStorage } from '@readtailor/storage';
import { analyzeBookPackage } from './book-analysis';
import type {
  NormalizationCoordinatorLogger,
  ValidatedNormalizationCandidate,
} from './coordinator';
import {
  createNormalizationRepository,
  type NormalizationRepository,
} from './repository';

const CONTRACT_VERSION = 'nb-1.0';
const MANIFEST_VERSION = 'reading-nodes-1.0';

function sameInventory(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

export async function publishValidatedNormalization(options: {
  db: Database;
  storage: ObjectStorage;
  normalizationRunId: string;
  candidate: ValidatedNormalizationCandidate;
  repoRoot: string;
  modelApiBaseUrl: string;
  modelApiKey: string;
  analysisModelName: string;
  analysisMaxTurns?: number;
  analysisTimeoutMs?: number;
  logger: NormalizationCoordinatorLogger;
  repository?: NormalizationRepository;
}): Promise<{
  bookId: string;
  packageId: string;
  packageVersion: string;
  objectPrefix: string;
}> {
  const repository = options.repository ?? createNormalizationRepository(options.db);
  const packageDirectory = options.candidate.directory;
  try {
    await repository.advanceStep(options.normalizationRunId, 'indexing');
    const normalizedHtml = join(packageDirectory, 'book.normalized.html');
    const manifestPath = join(packageDirectory, 'reading_manifest.json');
    const rebuiltManifestPath = join(packageDirectory, 'reading_manifest.rebuilt.json');
    const buildManifest = (output: string) =>
      runCommand(
        'python3',
        [
          join(options.repoRoot, 'tools/build_reading_nodes.py'),
          normalizedHtml,
          '--require-valid',
          '--output',
          output,
        ],
        { cwd: options.repoRoot, timeoutMs: 5 * 60_000 },
      );
    const firstBuild = await buildManifest(manifestPath);
    if (firstBuild.exitCode !== 0) {
      throw new Error(`reading manifest build failed: ${(firstBuild.stdout + firstBuild.stderr).slice(-4000)}`);
    }
    const secondBuild = await buildManifest(rebuiltManifestPath);
    if (secondBuild.exitCode !== 0) {
      throw new Error(`reading manifest rebuild failed: ${(secondBuild.stdout + secondBuild.stderr).slice(-4000)}`);
    }
    const [manifestBytes, rebuiltBytes] = await Promise.all([
      readFile(manifestPath),
      readFile(rebuiltManifestPath),
    ]);
    await rm(rebuiltManifestPath, { force: true });
    if (sha256(manifestBytes) !== sha256(rebuiltBytes)) {
      throw new Error('reading manifest is not deterministic for the normalized HTML');
    }

    await Promise.all([
      writeFile(
        join(packageDirectory, 'validation_report.txt'),
        options.candidate.validation.humanReport,
        'utf8',
      ),
      writeFile(
        join(packageDirectory, 'validation_report.json'),
        options.candidate.validation.reportBytes,
      ),
    ]);

    await repository.advanceStep(options.normalizationRunId, 'analyzing');
    const analysis = await analyzeBookPackage({
      repoRoot: options.repoRoot,
      packageDirectory,
      modelApiBaseUrl: options.modelApiBaseUrl,
      modelApiKey: options.modelApiKey,
      modelName: options.analysisModelName,
      ...(options.analysisMaxTurns ? { maxTurns: options.analysisMaxTurns } : {}),
      ...(options.analysisTimeoutMs ? { timeoutMs: options.analysisTimeoutMs } : {}),
      onTrace: (event) => {
        options.logger.info(
          { normalizationRunId: options.normalizationRunId, agentTrace: event },
          'agent trace',
        );
      },
    });

    const metadata = await readBookMetadata(packageDirectory);

    const derivedInventory = await buildArtifactInventory(packageDirectory);
    const derivedByPath = new Map(
      derivedInventory.files.map((entry) => [entry.path, entry] as const),
    );
    for (const verified of options.candidate.validation.outputInventory.files) {
      const current = derivedByPath.get(verified.path);
      if (
        !current ||
        current.sha256 !== verified.sha256 ||
        current.byteSize !== verified.byteSize
      ) {
        throw new Error(
          `worker-validated core artifact changed during indexing or analysis: ${verified.path}`,
        );
      }
    }
    if (metadata.cover_path) {
      const coverPath = assertSafeRelativePath(metadata.cover_path);
      if (!coverPath.startsWith('assets/') || !derivedByPath.has(coverPath)) {
        throw new Error('normalization metadata cover_path must reference an existing assets/ file');
      }
      metadata.cover_path = coverPath;
    }
    const coreInventory = derivedInventory;
    const packageManifest = {
      version: 'readtailor-package-manifest-1.0',
      contractVersion: CONTRACT_VERSION,
      manifestVersion: MANIFEST_VERSION,
      producerAttemptId: options.candidate.attemptId,
      normalizerScriptSha256: options.candidate.validation.binding.scriptSha256,
      workerValidation: options.candidate.validation.binding,
      bookAnalysis: {
        model: options.analysisModelName,
        turns: analysis.turns,
        toolCalls: analysis.toolCalls,
      },
      artifacts: coreInventory.files,
    };
    const packageManifestBytes = new TextEncoder().encode(
      `${JSON.stringify(packageManifest, null, 2)}\n`,
    );
    await writeFile(join(packageDirectory, 'package_manifest.json'), packageManifestBytes);
    const packageGateInventory = await buildArtifactInventory(packageDirectory);
    const packageGateReport = {
      version: 'readtailor-package-gate-1.0',
      outcome: 'passed',
      blockingErrorCount: 0,
      warningCount: 0,
      requiredFiles: [
        'book.normalized.html',
        'reading_manifest.json',
        'book_profile.json',
        'normalization_report.json',
        'metadata.json',
        'validation_report.txt',
        'validation_report.json',
        'package_manifest.json',
      ],
      packageInventorySha256: hashArtifactInventory(packageGateInventory),
      packageFiles: packageGateInventory.files,
      workerFinalValidation: options.candidate.validation.binding,
    };
    const packageGateReportBytes = new TextEncoder().encode(
      `${JSON.stringify(packageGateReport, null, 2)}\n`,
    );
    await writeFile(
      join(packageDirectory, 'package_validation_report.json'),
      packageGateReportBytes,
    );
    const fullInventory = await buildArtifactInventory(packageDirectory);
    const fullInventorySha256 = hashArtifactInventory(fullInventory);
    const packageVersion = `${CONTRACT_VERSION}-${fullInventorySha256.slice(0, 16)}`;

    const [run] = await options.db
      .select({
        sharedBookId: normalizationRuns.sharedBookId,
        epubSha256: sharedBooks.epubSha256,
        sourceFilename: sourceUploads.sourceFilename,
      })
      .from(normalizationRuns)
      .innerJoin(sharedBooks, eq(sharedBooks.id, normalizationRuns.sharedBookId))
      .innerJoin(sourceUploads, eq(sourceUploads.id, normalizationRuns.sourceUploadId))
      .where(eq(normalizationRuns.id, options.normalizationRunId))
      .limit(1);
    if (!run) throw new Error('normalization run no longer exists');
    const objectPrefix = `books/${run.epubSha256}/packages/${packageVersion}`;

    await repository.advanceStep(options.normalizationRunId, 'publishing');
    const publication = await publishImmutablePackage({
      storage: options.storage,
      packageDirectory,
      objectPrefix,
      requiredFiles: [
        'book.normalized.html',
        'reading_manifest.json',
        'book_profile.json',
        'normalization_report.json',
        'metadata.json',
        'validation_report.txt',
        'validation_report.json',
        'package_manifest.json',
        'package_validation_report.json',
      ],
    });
    if (publication.inventorySha256 !== fullInventorySha256) {
      throw new Error('package inventory changed between preparation and immutable upload');
    }
    const packageBinding: NormalizationFinishBinding = {
      sourceEpubSha256: options.candidate.validation.binding.sourceEpubSha256,
      scriptSha256: options.candidate.validation.binding.scriptSha256,
      outputInventorySha256: packageGateReport.packageInventorySha256,
      validatorVersion: packageGateReport.version,
      validationReportSha256: sha256(packageGateReportBytes),
      blockingErrorCount: 0,
      warningCount: 0,
    };
    await repository.recordValidation({
      attemptId: options.candidate.attemptId,
      phase: 'package',
      invocationNo: 1,
      binding: packageBinding,
      reportObjectKey: `${objectPrefix}/package_validation_report.json`,
      exitCode: 0,
      metrics: {
        packageGateFileCount: packageGateInventory.files.length,
        publishedFileCount: publication.inventory.files.length,
        publishedInventorySha256: publication.inventorySha256,
      },
    });

    const proposedPackageId = randomUUID();
    const profileBytes = await readFile(join(packageDirectory, 'book_profile.json'));
    const profileSha256 = sha256(profileBytes);
    let packageId: string = proposedPackageId;
    await options.db.transaction(async (tx) => {
      const [gate] = await tx
        .select({
          runStatus: normalizationRuns.status,
          runBookId: normalizationRuns.sharedBookId,
          attemptStatus: normalizationAttempts.status,
          attemptRunId: normalizationAttempts.normalizationRunId,
          hostValidationSha256: normalizationAttempts.hostValidationReportSha256,
          agentScriptSha256: normalizationAttempts.scriptSha256,
          attemptSourceSha256: normalizationAttempts.sourceEpubSha256,
          agentOutputSha256: normalizationAttempts.outputInventorySha256,
          agentValidatorVersion: normalizationAttempts.validatorVersion,
          hostOutputSha256: normalizationAttempts.hostOutputInventorySha256,
          hostValidatorVersion: normalizationAttempts.hostValidatorVersion,
          blockingErrorCount: normalizationAttempts.blockingErrorCount,
        })
        .from(normalizationRuns)
        .innerJoin(
          normalizationAttempts,
          eq(normalizationAttempts.id, options.candidate.attemptId),
        )
        .where(eq(normalizationRuns.id, options.normalizationRunId))
        .limit(1);
      if (
        !gate ||
        gate.runStatus !== 'running' ||
        gate.attemptStatus !== 'succeeded' ||
        gate.attemptRunId !== options.normalizationRunId ||
        gate.runBookId !== run.sharedBookId ||
        gate.attemptSourceSha256 !== run.epubSha256 ||
        options.candidate.validation.binding.sourceEpubSha256 !== run.epubSha256 ||
        gate.agentScriptSha256 !== options.candidate.validation.binding.scriptSha256 ||
        gate.agentOutputSha256 !== options.candidate.validation.binding.outputInventorySha256 ||
        gate.agentValidatorVersion !== options.candidate.validation.binding.validatorVersion ||
        gate.hostOutputSha256 !== options.candidate.validation.binding.outputInventorySha256 ||
        gate.hostValidatorVersion !== options.candidate.validation.binding.validatorVersion ||
        gate.blockingErrorCount !== 0 ||
        gate.hostValidationSha256 !==
          options.candidate.validation.binding.validationReportSha256
      ) {
        throw new Error('publication gate is stale or does not match worker final validation');
      }

      await tx
        .insert(bookPackages)
        .values({
          id: proposedPackageId,
          sharedBookId: run.sharedBookId,
          producerAttemptId: options.candidate.attemptId,
          version: packageVersion,
          contractVersion: CONTRACT_VERSION,
          manifestVersion: MANIFEST_VERSION,
          objectPrefix,
          fileHashes: publication.fileHashes,
          validationSummary: {
            workerFinal: options.candidate.validation.binding,
            packageGate: packageBinding,
            publishedInventorySha256: publication.inventorySha256,
            baselineSha256: run.epubSha256,
            exitCode: options.candidate.validation.exitCode,
          },
          packageManifestObjectKey: `${objectPrefix}/package_manifest.json`,
          packageManifestSha256: sha256(packageManifestBytes),
        })
        .onConflictDoNothing({ target: [bookPackages.sharedBookId, bookPackages.version] });
      const [savedPackage] = await tx
        .select({
          id: bookPackages.id,
          objectPrefix: bookPackages.objectPrefix,
          fileHashes: bookPackages.fileHashes,
          producerAttemptId: bookPackages.producerAttemptId,
        })
        .from(bookPackages)
        .where(
          and(
            eq(bookPackages.sharedBookId, run.sharedBookId),
            eq(bookPackages.version, packageVersion),
          ),
        )
        .limit(1);
      if (
        !savedPackage ||
        savedPackage.objectPrefix !== objectPrefix ||
        savedPackage.producerAttemptId !== options.candidate.attemptId ||
        !sameInventory(savedPackage.fileHashes, publication.fileHashes)
      ) {
        throw new Error('existing immutable package row conflicts with the published artifacts');
      }
      packageId = savedPackage.id;
      await tx
        .insert(bookProfiles)
        .values({
          packageId,
          objectKey: `${objectPrefix}/book_profile.json`,
          sha256: profileSha256,
        })
        .onConflictDoNothing({ target: bookProfiles.packageId });
      const [savedProfile] = await tx
        .select({ objectKey: bookProfiles.objectKey, sha256: bookProfiles.sha256 })
        .from(bookProfiles)
        .where(eq(bookProfiles.packageId, packageId))
        .limit(1);
      if (
        !savedProfile ||
        savedProfile.objectKey !== `${objectPrefix}/book_profile.json` ||
        savedProfile.sha256 !== profileSha256
      ) {
        throw new Error('existing book profile row conflicts with the published profile');
      }
      const updatedBook = await tx
        .update(sharedBooks)
        .set({
          status: 'ready',
          title: metadata.title,
          authors: metadata.authors,
          language: metadata.language,
          coverPath: metadata.cover_path,
          identifiers: metadata.identifiers,
          publisher: metadata.publisher,
          publishedDate: metadata.published_date,
          sourceFilename: run.sourceFilename,
          currentPackageId: packageId,
          errorSummary: null,
          updatedAt: sql`now()`,
        })
        .where(eq(sharedBooks.id, run.sharedBookId))
        .returning({ id: sharedBooks.id });
      if (updatedBook.length !== 1) throw new Error('shared book disappeared during publication');
      const completedRun = await tx
        .update(normalizationRuns)
        .set({ status: 'completed', step: 'published', completedAt: sql`now()` })
        .where(
          and(
            eq(normalizationRuns.id, options.normalizationRunId),
            eq(normalizationRuns.status, 'running'),
          ),
        )
        .returning({ id: normalizationRuns.id });
      if (completedRun.length !== 1) throw new Error('normalization run became stale during publication');
    });

    return {
      bookId: run.sharedBookId,
      packageId,
      packageVersion,
      objectPrefix,
    };
  } finally {
    await options.candidate.cleanup();
  }
}
