import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { and, eq, sql } from 'drizzle-orm';
import {
  readLogLevel,
  readModelEndpoint,
  requireCompleteModelEndpoint,
  requireString,
} from '@readtailor/config';
import {
  bookPackages,
  bookProfiles,
  createDatabase,
  normalizationAttempts,
  normalizationRuns,
  sharedBooks,
  sourceUploads,
} from '@readtailor/database';
import { createLogger } from '@readtailor/observability';
import { sha256 } from '@readtailor/normalized-book';
import { createObjectStorage, ObjectNotFoundError } from '@readtailor/storage';
import { loadNormalizationSandboxConfig } from './config';
import { runFormalNormalization } from './normalization/coordinator';
import { publishValidatedNormalization } from './normalization/publication';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function integer(name: string, fallback: number, min: number): number {
  const value = optional(name);
  const number = value ? Number(value) : fallback;
  if (!Number.isInteger(number) || number < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return number;
}

async function main(): Promise<void> {
  const sourcePath = resolve(REPO_ROOT, process.argv[2] ?? 'fixtures/fixed_input.epub');
  const source = await readFile(sourcePath);
  if (source.byteLength > 100 * 1024 * 1024) {
    throw new Error('source EPUB exceeds the 100 MB limit');
  }
  const epubSha256 = sha256(source);
  const databaseUrl = requireString(process.env, 'DATABASE_URL');
  const loadedSandbox = loadNormalizationSandboxConfig(process.env);
  if (!loadedSandbox.sandbox) {
    const keyName = loadedSandbox.provider === 'ppio' ? 'PPIO_API_KEY' : 'E2B_API_KEY';
    throw new Error(
      `${keyName} is required when SANDBOX_PROVIDER=${loadedSandbox.provider}`,
    );
  }
  const normalizationSandbox = loadedSandbox.sandbox;
  const normalizationModel = requireCompleteModelEndpoint(
    readModelEndpoint(process.env, 'NORMALIZATION'),
    'normalization',
  );
  if (!normalizationModel) {
    throw new Error(
      'normalization model not configured: set MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_NAME (or the NORMALIZATION_MODEL_* overrides)',
    );
  }
  const analysisModel = requireCompleteModelEndpoint(
    readModelEndpoint(process.env, 'BOOK_ANALYSIS', 'NORMALIZATION'),
    'book-analysis',
  );
  if (!analysisModel) {
    throw new Error(
      'book-analysis model not configured: set MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_NAME (or the BOOK_ANALYSIS_MODEL_* overrides)',
    );
  }
  const storage = createObjectStorage({
    localRoot: optional('OBJECT_STORAGE_LOCAL_ROOT')
      ? resolve(REPO_ROOT, requireString(process.env, 'OBJECT_STORAGE_LOCAL_ROOT'))
      : undefined,
    endpoint: optional('OBJECT_STORAGE_ENDPOINT'),
    region: optional('OBJECT_STORAGE_REGION'),
    bucket: optional('OBJECT_STORAGE_BUCKET'),
    accessKeyId: optional('OBJECT_STORAGE_ACCESS_KEY_ID'),
    secretAccessKey: optional('OBJECT_STORAGE_SECRET_ACCESS_KEY'),
  });
  if (!storage) throw new Error('object storage is required');

  const database = createDatabase(databaseUrl);
  const logger = createLogger(readLogLevel(process.env, 'LOG_LEVEL', 'info'));
  let runId: string | undefined;
  let bookId: string | undefined;
  let runCreated = false;

  try {
    const [ready] = await database.db
      .select({
        bookId: sharedBooks.id,
        packageId: bookPackages.id,
        producerAttemptId: bookPackages.producerAttemptId,
        objectPrefix: bookPackages.objectPrefix,
        fileHashes: bookPackages.fileHashes,
        profileKey: bookProfiles.objectKey,
        profileSha256: bookProfiles.sha256,
      })
      .from(sharedBooks)
      .innerJoin(bookPackages, eq(bookPackages.id, sharedBooks.currentPackageId))
      .innerJoin(bookProfiles, eq(bookProfiles.packageId, bookPackages.id))
      .where(and(eq(sharedBooks.epubSha256, epubSha256), eq(sharedBooks.status, 'ready')))
      .limit(1);
    if (ready) {
      const formalRequiredReadyFiles = [
        'book.normalized.html',
        'reading_manifest.json',
        'book_profile.json',
        'normalization_report.json',
        'metadata.json',
        'validation_report.txt',
        'validation_report.json',
        'package_manifest.json',
        'package_validation_report.json',
      ];
      const legacyRequiredReadyFiles = [
        'book.normalized.html',
        'reading_manifest.json',
        'book_profile.json',
        'normalization_report.json',
        'validation_report.txt',
      ];
      const requiredReadyFiles = ready.producerAttemptId
        ? formalRequiredReadyFiles
        : legacyRequiredReadyFiles;
      let complete =
        ready.profileKey === `${ready.objectPrefix}/book_profile.json` &&
        ready.profileSha256 === ready.fileHashes['book_profile.json'] &&
        requiredReadyFiles.every((path) => Boolean(ready.fileHashes[path]));
      for (const [path, expected] of Object.entries(ready.fileHashes)) {
        try {
          const bytes = await storage.get(`${ready.objectPrefix}/${path}`);
          if (sha256(bytes) !== expected) {
            complete = false;
            break;
          }
        } catch (error) {
          if (error instanceof ObjectNotFoundError) {
            complete = false;
            break;
          }
          throw error;
        }
      }
      if (complete) {
        process.stdout.write(
          `${JSON.stringify({ reused: true, bookId: ready.bookId, packageId: ready.packageId, epubSha256 }, null, 2)}\n`,
        );
        return;
      }
      throw new Error('ready package inventory is incomplete or corrupt; repair runs are not automatic yet');
    }

    const sourceObjectKey = `uploads/by-sha256/${epubSha256}/source.epub`;
    const put = await storage.putIfAbsent(sourceObjectKey, source, 'application/epub+zip');
    if (!put.created && sha256(await storage.get(sourceObjectKey)) !== epubSha256) {
      throw new Error('immutable source EPUB object has conflicting content');
    }

    const proposedBookId = randomUUID();
    await database.db
      .insert(sharedBooks)
      .values({
        id: proposedBookId,
        epubSha256,
        status: 'queued',
        title: basename(sourcePath, '.epub'),
        authors: [],
        language: 'und',
        identifiers: {},
        sourceFilename: basename(sourcePath),
      })
      .onConflictDoNothing({ target: sharedBooks.epubSha256 });
    const [book] = await database.db
      .select({ id: sharedBooks.id, currentPackageId: sharedBooks.currentPackageId })
      .from(sharedBooks)
      .where(eq(sharedBooks.epubSha256, epubSha256))
      .limit(1);
    if (!book) throw new Error('failed to create or load the shared book');
    bookId = book.id;

    await database.db.transaction(async (tx) => {
      await tx
        .update(normalizationAttempts)
        .set({
          status: 'abandoned',
          errorClass: 'stale_worker',
          errorSummary: 'attempt exceeded its explicit execution deadline',
          completedAt: sql`now()`,
        })
        .where(
          and(
            eq(normalizationAttempts.status, 'running'),
            sql`${normalizationAttempts.deadlineAt} < now()`,
            sql`${normalizationAttempts.normalizationRunId} in (select id from normalization_runs where shared_book_id = ${book.id})`,
          ),
        );
      await tx
        .update(normalizationRuns)
        .set({
          status: 'failed',
          errorSummary: 'run heartbeat expired without an active attempt',
          completedAt: sql`now()`,
        })
        .where(
          and(
            eq(normalizationRuns.sharedBookId, book.id),
            eq(normalizationRuns.status, 'running'),
            sql`${normalizationRuns.heartbeatAt} < now() - interval '45 minutes'`,
            sql`not exists (select 1 from normalization_attempts where normalization_run_id = ${normalizationRuns.id} and status = 'running')`,
          ),
        );
    });

    const uploadId = randomUUID();
    const currentRunId = randomUUID();
    runId = currentRunId;
    await database.db.transaction(async (tx) => {
      await tx
        .insert(sourceUploads)
        .values({
          id: uploadId,
          sharedBookId: book.id,
          sourceObjectKey,
          sourceFilename: basename(sourcePath),
          mediaType: 'application/epub+zip',
          byteSize: source.byteLength,
          epubSha256,
          status: 'stored',
        })
        .onConflictDoNothing({ target: sourceUploads.sourceObjectKey });
      const [upload] = await tx
        .select({ id: sourceUploads.id, sharedBookId: sourceUploads.sharedBookId })
        .from(sourceUploads)
        .where(eq(sourceUploads.sourceObjectKey, sourceObjectKey))
        .limit(1);
      if (!upload || upload.sharedBookId !== book.id) {
        throw new Error('source upload does not belong to the shared book');
      }
      const [next] = await tx
        .select({ attempt: sql<number>`coalesce(max(${normalizationRuns.attempt}), 0) + 1` })
        .from(normalizationRuns)
        .where(eq(normalizationRuns.sharedBookId, book.id));
      await tx.insert(normalizationRuns).values({
        id: currentRunId,
        sharedBookId: book.id,
        sourceUploadId: upload.id,
        status: 'running',
        step: 'normalizing',
        attempt: Number(next?.attempt ?? 1),
      });
      if (!book.currentPackageId) {
        await tx
          .update(sharedBooks)
          .set({ status: 'normalizing', errorSummary: null, updatedAt: sql`now()` })
          .where(eq(sharedBooks.id, book.id));
      }
    });
    runCreated = true;

    const candidate = await runFormalNormalization({
      db: database.db,
      storage,
      normalizationRunId: currentRunId,
      sourceEpub: source,
      repoRoot: REPO_ROOT,
      sandbox: normalizationSandbox,
      modelApiBaseUrl: normalizationModel.baseUrl,
      modelApiKey: normalizationModel.apiKey,
      modelName: normalizationModel.modelName,
      maxAttempts: integer('NORMALIZATION_MAX_ATTEMPTS', 3, 1),
      maxTurns: integer('NORMALIZATION_MAX_TURNS', 50, 1),
      attemptTimeoutMs: integer('NORMALIZATION_ATTEMPT_TIMEOUT_MS', 30 * 60_000, 60_000),
      logger,
    });
    const publication = await publishValidatedNormalization({
      db: database.db,
      storage,
      normalizationRunId: currentRunId,
      candidate,
      repoRoot: REPO_ROOT,
      modelApiBaseUrl: analysisModel.baseUrl,
      modelApiKey: analysisModel.apiKey,
      analysisModelName: analysisModel.modelName,
      analysisMaxTurns: integer('BOOK_ANALYSIS_MAX_TURNS', 20, 1),
      analysisTimeoutMs: integer('BOOK_ANALYSIS_TIMEOUT_MS', 20 * 60_000, 60_000),
      logger,
    });
    process.stdout.write(
      `${JSON.stringify({ reused: false, epubSha256, ...publication }, null, 2)}\n`,
    );
  } catch (error) {
    const summary = error instanceof Error ? error.message : String(error);
    if (runCreated && runId) {
      await database.db
        .update(normalizationRuns)
        .set({ status: 'failed', errorSummary: summary.slice(0, 2000), completedAt: sql`now()` })
        .where(and(eq(normalizationRuns.id, runId), eq(normalizationRuns.status, 'running')))
        .catch(() => undefined);
    }
    if (runCreated && bookId) {
      await database.db
        .update(sharedBooks)
        .set({ status: 'failed', errorSummary: summary.slice(0, 2000), updatedAt: sql`now()` })
        .where(and(eq(sharedBooks.id, bookId), sql`${sharedBooks.currentPackageId} is null`))
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await database.client.end({ timeout: 5 });
  }
}

await main();
