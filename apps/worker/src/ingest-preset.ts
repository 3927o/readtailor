import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { readOptionalBoolean } from '@readtailor/config';
import {
  bookPackages,
  bookProfiles,
  createDatabase,
  normalizationRuns,
  sharedBooks,
  sourceUploads,
} from '@readtailor/database';
import {
  publishImmutablePackage,
  readBookMetadata,
  validateNormalizedCandidate,
} from '@readtailor/normalized-book';
import {
  createObjectStorage,
  ObjectNotFoundError,
  type ObjectStorage,
} from '@readtailor/storage';

// Preset ingest: like ingest-fixture, but the normalizer is the multi-book
// tools/normalize_preset_epub.py and the book profile is a reviewed JSON file
// checked into tools/preset_profiles/ instead of an inline constant.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const NORMALIZER = 'tools/normalize_preset_epub.py';
const PACKAGE_VERSION = 'nb-1.0-preset-v1';
const CONTRACT_VERSION = 'nb-1.0';
const MANIFEST_VERSION = 'reading-nodes-1.0';

type ManifestNode = {
  section_id: string;
  segment: number;
  order: number;
  title: string;
  tailoring_eligible: boolean;
};

type ReadingManifest = {
  version: string;
  nodes: ManifestNode[];
  [key: string]: unknown;
};

type TrialCandidate = {
  section_id: string;
  segment: number;
  features: string[];
  reason: string;
};

type BookProfile = {
  version: string;
  summary: string;
  structure: string;
  core_questions: string[];
  themes: string[];
  reading_barriers: string[];
  reading_advice: string[];
  trial_candidates: TrialCandidate[];
};

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameHashInventory(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const leftKeys = Object.keys(left);
  return (
    leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; allowedExitCodes?: number[] },
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if ((options.allowedExitCodes ?? [0]).includes(code ?? -1)) {
        resolvePromise(`${output}${errorOutput}`);
      } else {
        reject(
          new Error(
            `${command} ${args.join(' ')} failed with exit code ${code}\n${output}${errorOutput}`,
          ),
        );
      }
    });
  });
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join('/'));
      }
    }
  };
  await visit(root);
  return files.sort();
}

function nonEmptyStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'string' && item.trim().length > 0)
  );
}

function parseBookProfile(raw: string, manifest: ReadingManifest): BookProfile {
  const value = JSON.parse(raw) as BookProfile;
  if (value.version !== 'book-profile-1.0') {
    throw new Error(`book profile version must be book-profile-1.0, got ${value.version}`);
  }
  for (const key of ['summary', 'structure'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim().length < 20) {
      throw new Error(`book profile ${key} is missing or too short`);
    }
  }
  for (const key of ['core_questions', 'themes', 'reading_barriers', 'reading_advice'] as const) {
    if (!nonEmptyStrings(value[key])) {
      throw new Error(`book profile ${key} must be a non-empty string array`);
    }
  }
  if (!Array.isArray(value.trial_candidates) || value.trial_candidates.length < 9) {
    throw new Error('book profile requires at least 9 trial candidates');
  }
  const eligible = new Set(
    manifest.nodes
      .filter((node) => node.tailoring_eligible)
      .map((node) => `${node.section_id}#${node.segment}`),
  );
  const seen = new Set<string>();
  for (const candidate of value.trial_candidates) {
    const key = `${candidate.section_id}#${candidate.segment}`;
    if (!eligible.has(key)) {
      throw new Error(`trial candidate ${key} is not a tailoring-eligible manifest node`);
    }
    if (seen.has(key)) {
      throw new Error(`trial candidate ${key} is duplicated`);
    }
    seen.add(key);
    if (!nonEmptyStrings(candidate.features)) {
      throw new Error(`trial candidate ${key} needs at least one feature`);
    }
    if (typeof candidate.reason !== 'string' || candidate.reason.trim().length < 5) {
      throw new Error(`trial candidate ${key} needs a reason`);
    }
  }
  return value;
}

async function putImmutable(
  storage: ObjectStorage,
  key: string,
  body: Uint8Array,
  type?: string,
): Promise<void> {
  const result = await storage.putIfAbsent(key, body, type);
  if (!result.created) {
    const existing = await storage.get(key);
    if (sha256(existing) !== sha256(body)) {
      throw new Error(`immutable object already exists with different content: ${key}`);
    }
  }
}

async function packageInventoryIsComplete(
  storage: ObjectStorage,
  objectPrefix: string,
  fileHashes: Record<string, string>,
): Promise<boolean> {
  const required = [
    'book.normalized.html',
    'reading_manifest.json',
    'book_profile.json',
    'normalization_report.json',
    'metadata.json',
    'validation_report.txt',
  ];
  if (required.some((path) => !fileHashes[path])) {
    return false;
  }
  for (const [path, expectedHash] of Object.entries(fileHashes)) {
    try {
      const bytes = await storage.get(`${objectPrefix}/${path}`);
      if (sha256(bytes) !== expectedHash) {
        return false;
      }
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return false;
      }
      throw error;
    }
  }
  return true;
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }
  const storage = createObjectStorage({
    localRoot: process.env.OBJECT_STORAGE_LOCAL_ROOT?.trim()
      ? resolve(REPO_ROOT, process.env.OBJECT_STORAGE_LOCAL_ROOT.trim())
      : undefined,
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT?.trim(),
    region: process.env.OBJECT_STORAGE_REGION?.trim() || undefined,
    bucket: process.env.OBJECT_STORAGE_BUCKET?.trim(),
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim(),
    forcePathStyle: readOptionalBoolean(process.env, 'OBJECT_STORAGE_FORCE_PATH_STYLE'),
  });
  if (!storage) {
    throw new Error('object storage is required (OBJECT_STORAGE_LOCAL_ROOT or OBJECT_STORAGE_BUCKET)');
  }

  const sourceArg = process.argv[2];
  const profileArg = process.argv[3];
  if (!sourceArg || !profileArg) {
    throw new Error('usage: ingest-preset <book.epub> <book_profile.json>');
  }
  const sourcePath = resolve(REPO_ROOT, sourceArg);
  const profilePath = resolve(REPO_ROOT, profileArg);
  const source = await readFile(sourcePath);
  const profileRaw = await readFile(profilePath, 'utf8');
  const epubSha256 = sha256(source);
  const database = createDatabase(databaseUrl);
  let runId: string | undefined;
  let sharedBookId: string | undefined;
  let runCreated = false;
  const workspace = await mkdtemp(join(tmpdir(), 'readtailor-ingest-'));

  try {
    const [ready] = await database.db
      .select({
        bookId: sharedBooks.id,
        packageId: bookPackages.id,
        version: bookPackages.version,
        objectPrefix: bookPackages.objectPrefix,
        fileHashes: bookPackages.fileHashes,
        profileObjectKey: bookProfiles.objectKey,
        profileSha256: bookProfiles.sha256,
      })
      .from(sharedBooks)
      .innerJoin(bookPackages, eq(bookPackages.id, sharedBooks.currentPackageId))
      .innerJoin(bookProfiles, eq(bookProfiles.packageId, bookPackages.id))
      .where(and(eq(sharedBooks.epubSha256, epubSha256), eq(sharedBooks.status, 'ready')))
      .limit(1);
    if (
      ready &&
      // 只有当现行包的版本与目标 PACKAGE_VERSION 一致时才复用；否则（升版本 =
      // normalize/打包逻辑变更）必须重跑发布新版本，不能被旧 ready 包挡住。
      ready.version === PACKAGE_VERSION &&
      ready.profileObjectKey === `${ready.objectPrefix}/book_profile.json` &&
      ready.profileSha256 === ready.fileHashes['book_profile.json'] &&
      (await packageInventoryIsComplete(storage, ready.objectPrefix, ready.fileHashes))
    ) {
      process.stdout.write(
        `${JSON.stringify(
          {
            reused: true,
            bookId: ready.bookId,
            packageId: ready.packageId,
            objectPrefix: ready.objectPrefix,
            epubSha256,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const proposedUploadId = randomUUID();
    const currentRunId = randomUUID();
    runId = currentRunId;
    const proposedBookId = randomUUID();
    const sourceObjectKey = `uploads/by-sha256/${epubSha256}/source.epub`;
    await putImmutable(storage, sourceObjectKey, source, 'application/epub+zip');

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
      .select({ id: sharedBooks.id })
      .from(sharedBooks)
      .where(eq(sharedBooks.epubSha256, epubSha256))
      .limit(1);
    if (!book) {
      throw new Error('failed to create or load shared book');
    }
    const currentSharedBookId = book.id;
    sharedBookId = currentSharedBookId;

    // A killed management process has no worker heartbeat to settle its run.
    // Reclaim only preset runs older than one hour; normal runs finish in minutes.
    await database.db
      .update(normalizationRuns)
      .set({
        status: 'failed',
        errorSummary: 'stale preset normalization run reclaimed by a retry',
        completedAt: sql`now()`,
      })
      .where(
        and(
          eq(normalizationRuns.sharedBookId, currentSharedBookId),
          eq(normalizationRuns.status, 'running'),
          sql`${normalizationRuns.startedAt} < now() - interval '1 hour'`,
        ),
      );

    await database.db.transaction(async (tx) => {
      await tx
        .insert(sourceUploads)
        .values({
          id: proposedUploadId,
          sharedBookId: currentSharedBookId,
          sourceObjectKey,
          sourceFilename: basename(sourcePath),
          mediaType: 'application/epub+zip',
          byteSize: source.byteLength,
          epubSha256,
          status: 'stored',
        })
        .onConflictDoNothing({ target: sourceUploads.sourceObjectKey });
      const [upload] = await tx
        .select({
          id: sourceUploads.id,
          sharedBookId: sourceUploads.sharedBookId,
          epubSha256: sourceUploads.epubSha256,
        })
        .from(sourceUploads)
        .where(eq(sourceUploads.sourceObjectKey, sourceObjectKey))
        .limit(1);
      if (
        !upload ||
        upload.sharedBookId !== currentSharedBookId ||
        upload.epubSha256 !== epubSha256
      ) {
        throw new Error('existing source upload record does not match the preset source');
      }
      const [attemptRow] = await tx
        .select({
          attempt: sql<number>`coalesce(max(${normalizationRuns.attempt}), 0) + 1`,
        })
        .from(normalizationRuns)
        .where(eq(normalizationRuns.sharedBookId, currentSharedBookId));
      await tx.insert(normalizationRuns).values({
        id: currentRunId,
        sharedBookId: currentSharedBookId,
        sourceUploadId: upload.id,
        status: 'running',
        step: 'normalizing',
        attempt: Number(attemptRow?.attempt ?? 1),
      });
      await tx
        .update(sharedBooks)
        .set({ status: 'normalizing', errorSummary: null, updatedAt: sql`now()` })
        .where(eq(sharedBooks.id, currentSharedBookId));
    });
    runCreated = true;

    const packageDir = join(workspace, 'package');
    await runCommand(
      'python3',
      [join(REPO_ROOT, NORMALIZER), sourcePath, packageDir],
      { cwd: REPO_ROOT },
    );
    await database.db
      .update(normalizationRuns)
      .set({ step: 'indexing' })
      .where(eq(normalizationRuns.id, currentRunId));
    await database.db
      .update(sharedBooks)
      .set({ status: 'indexing', updatedAt: sql`now()` })
      .where(eq(sharedBooks.id, currentSharedBookId));

    const normalizedHtml = join(packageDir, 'book.normalized.html');
    const manifestPath = join(packageDir, 'reading_manifest.json');
    await runCommand(
      'python3',
      [
        join(REPO_ROOT, 'tools/build_reading_nodes.py'),
        normalizedHtml,
        '--require-valid',
        '--output',
        manifestPath,
      ],
      { cwd: REPO_ROOT },
    );
    const rebuiltManifestPath = join(workspace, 'reading_manifest.rebuilt.json');
    await runCommand(
      'python3',
      [
        join(REPO_ROOT, 'tools/build_reading_nodes.py'),
        normalizedHtml,
        '--require-valid',
        '--output',
        rebuiltManifestPath,
      ],
      { cwd: REPO_ROOT },
    );
    const manifestBytes = await readFile(manifestPath);
    const rebuiltManifestBytes = await readFile(rebuiltManifestPath);
    if (sha256(manifestBytes) !== sha256(rebuiltManifestBytes)) {
      throw new Error('reading manifest is not deterministic for the immutable normalized HTML');
    }
    const hostValidation = await validateNormalizedCandidate({
      repoRoot: REPO_ROOT,
      sourceEpubPath: sourcePath,
      outputDirectory: packageDir,
      normalizerScript: await readFile(join(REPO_ROOT, NORMALIZER)),
    });
    await writeFile(
      join(packageDir, 'validation_report.txt'),
      hostValidation.humanReport,
      'utf8',
    );
    await writeFile(
      join(packageDir, 'validation_report.json'),
      hostValidation.reportBytes,
    );

    const metadata = await readBookMetadata(packageDir);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as ReadingManifest;
    if (manifest.version !== MANIFEST_VERSION) {
      throw new Error(`unexpected manifest version: ${manifest.version}`);
    }
    const bookProfile = parseBookProfile(profileRaw, manifest);
    await writeFile(
      join(packageDir, 'book_profile.json'),
      `${JSON.stringify(bookProfile, null, 2)}\n`,
      'utf8',
    );

    const files = await listFiles(packageDir);
    const required = [
      'book.normalized.html',
      'reading_manifest.json',
      'book_profile.json',
      'normalization_report.json',
      'metadata.json',
      'validation_report.txt',
    ];
    for (const name of required) {
      if (!files.includes(name)) {
        throw new Error(`normalized package is missing required file: ${name}`);
      }
    }

    const objectPrefix = `books/${epubSha256}/packages/${PACKAGE_VERSION}`;
    const publication = await publishImmutablePackage({
      storage,
      packageDirectory: packageDir,
      objectPrefix,
      requiredFiles: [
        'book.normalized.html',
        'reading_manifest.json',
        'book_profile.json',
        'normalization_report.json',
        'metadata.json',
        'validation_report.txt',
        'validation_report.json',
      ],
    });
    const fileHashes = publication.fileHashes;

    const proposedPackageId = randomUUID();
    const profileBytes = await readFile(join(packageDir, 'book_profile.json'));
    let publishedPackageId: string = proposedPackageId;
    await database.db.transaction(async (tx) => {
      await tx
        .insert(bookPackages)
        .values({
          id: proposedPackageId,
          sharedBookId: currentSharedBookId,
          version: PACKAGE_VERSION,
          contractVersion: CONTRACT_VERSION,
          manifestVersion: MANIFEST_VERSION,
          objectPrefix,
          fileHashes,
          validationSummary: {
            validator: hostValidation.binding.validatorVersion,
            baselineSha256: epubSha256,
            exitCode: hostValidation.exitCode,
            blockingErrorCount: hostValidation.binding.blockingErrorCount,
            warningCount: hostValidation.binding.warningCount,
            outputInventorySha256: hostValidation.binding.outputInventorySha256,
            validationReportSha256: hostValidation.binding.validationReportSha256,
          },
        })
        .onConflictDoNothing({ target: [bookPackages.sharedBookId, bookPackages.version] });
      const [publishedPackage] = await tx
        .select({
          id: bookPackages.id,
          objectPrefix: bookPackages.objectPrefix,
          fileHashes: bookPackages.fileHashes,
        })
        .from(bookPackages)
        .where(
          and(
            eq(bookPackages.sharedBookId, currentSharedBookId),
            eq(bookPackages.version, PACKAGE_VERSION),
          ),
        )
        .limit(1);
      if (!publishedPackage) {
        throw new Error('failed to publish book package record');
      }
      if (
        publishedPackage.objectPrefix !== objectPrefix ||
        !sameHashInventory(publishedPackage.fileHashes, fileHashes)
      ) {
        throw new Error('existing immutable package record does not match generated artifacts');
      }
      publishedPackageId = publishedPackage.id;
      const expectedProfileObjectKey = `${objectPrefix}/book_profile.json`;
      const expectedProfileSha256 = sha256(profileBytes);
      await tx
        .insert(bookProfiles)
        .values({
          packageId: publishedPackage.id,
          objectKey: expectedProfileObjectKey,
          sha256: expectedProfileSha256,
        })
        .onConflictDoNothing({ target: bookProfiles.packageId });
      const [publishedProfile] = await tx
        .select({ objectKey: bookProfiles.objectKey, sha256: bookProfiles.sha256 })
        .from(bookProfiles)
        .where(eq(bookProfiles.packageId, publishedPackage.id))
        .limit(1);
      if (
        !publishedProfile ||
        publishedProfile.objectKey !== expectedProfileObjectKey ||
        publishedProfile.sha256 !== expectedProfileSha256
      ) {
        throw new Error('existing book profile record does not match generated artifact');
      }
      await tx
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
          sourceFilename: metadata.source_filename,
          currentPackageId: publishedPackage.id,
          errorSummary: null,
          updatedAt: sql`now()`,
        })
        .where(eq(sharedBooks.id, currentSharedBookId));
      await tx
        .update(normalizationRuns)
        .set({ status: 'completed', step: 'published', completedAt: sql`now()` })
        .where(eq(normalizationRuns.id, currentRunId));
    });

    process.stdout.write(
      `${JSON.stringify(
        {
          reused: false,
          bookId: currentSharedBookId,
          packageId: publishedPackageId,
          epubSha256,
          objectPrefix,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    const summary = error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000);
    if (runCreated && runId) {
      await database.db
        .update(normalizationRuns)
        .set({ status: 'failed', errorSummary: summary, completedAt: sql`now()` })
        .where(eq(normalizationRuns.id, runId))
        .catch(() => undefined);
    }
    if (runCreated && sharedBookId) {
      await database.db
        .update(sharedBooks)
        .set({ status: 'failed', errorSummary: summary, updatedAt: sql`now()` })
        .where(
          and(
            eq(sharedBooks.id, sharedBookId),
            inArray(sharedBooks.status, ['normalizing', 'indexing']),
          ),
        )
        .catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await database.client.end({ timeout: 5 });
  }
}

await main();
