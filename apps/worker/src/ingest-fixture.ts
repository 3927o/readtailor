import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  bookPackages,
  bookProfiles,
  createDatabase,
  normalizationRuns,
  sharedBooks,
  sourceUploads,
} from '@readtailor/database';
import { createObjectStorage, type ObjectStorage } from '@readtailor/storage';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACKAGE_VERSION = 'nb-1.0-v1';
const CONTRACT_VERSION = 'nb-1.0';
const MANIFEST_VERSION = 'reading-nodes-1.0';

type NormalizationReport = {
  metadata: {
    title: string;
    authors: string[];
    language: string;
    cover_path: string | null;
    identifiers: Record<string, string>;
    publisher: string | null;
    published_date: string | null;
    source_filename: string;
  };
  [key: string]: unknown;
};

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

function selectTrialCandidates(nodes: ManifestNode[]) {
  const eligible = nodes.filter((node) => node.tailoring_eligible);
  if (eligible.length < 9) {
    throw new Error(`book profile requires at least 9 eligible nodes, found ${eligible.length}`);
  }
  const count = Math.min(12, eligible.length);
  const selected = Array.from({ length: count }, (_, index) => {
    const position = Math.round((index * (eligible.length - 1)) / Math.max(1, count - 1));
    const node = eligible[position];
    if (!node) {
      throw new Error(`failed to select trial candidate at position ${position}`);
    }
    return node;
  });
  return selected.map((node, index) => ({
    section_id: node.section_id,
    segment: node.segment,
    features: [
      index < 3 ? 'entry' : index >= count - 3 ? 'high_difficulty' : 'typical',
      index % 2 === 0 ? 'conceptual' : 'rhetorical',
    ],
    reason: `覆盖全书第 ${node.order} 个阅读节点，用于观察该位置的概念密度与表达方式。`,
  }));
}

function createBookProfile(manifest: ReadingManifest) {
  return {
    version: 'book-profile-1.0',
    summary:
      '全书以查拉图斯特拉的游历、演说和寓言展开，围绕自我超越、价值创造、永恒轮回与现代人的精神处境推进。',
    structure:
      '正文分为四部，章节多为相对独立的演说或寓言；概念会跨章节反复出现，并在后半部形成更强的回环。',
    core_questions: [
      '人在旧价值失效后如何创造新的价值？',
      '自我超越与权力意志在具体生活中意味着什么？',
      '永恒轮回为何既是思想实验也是生存考验？',
    ],
    themes: ['自我超越', '价值创造', '权力意志', '永恒轮回', '孤独与共同体'],
    reading_barriers: [
      '寓言、反讽和宗教戏仿交织，字面理解容易偏离论证意图。',
      '关键概念分散出现，单章往往不能给出完整定义。',
      '大量译注和文化典故会打断连续阅读。',
    ],
    reading_advice: [
      '先把每章视为一次独立演说，再追踪重复出现的核心意象。',
      '区分人物话语、叙述者语气和反讽对象，不急于把句子归纳为教条。',
      '遇到密集典故时优先保持正文推进，只在影响理解时展开原书注。',
    ],
    trial_candidates: selectTrialCandidates(manifest.nodes),
  };
}

function contentType(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase();
  return {
    html: 'text/html; charset=utf-8',
    json: 'application/json',
    txt: 'text/plain; charset=utf-8',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
  }[extension ?? ''];
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
    } catch {
      return false;
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
  });
  if (!storage) {
    throw new Error('object storage is required (OBJECT_STORAGE_LOCAL_ROOT or OBJECT_STORAGE_BUCKET)');
  }

  const sourcePath = resolve(REPO_ROOT, process.argv[2] ?? 'fixtures/fixed_input.epub');
  const source = await readFile(sourcePath);
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
    // Reclaim only fixture runs older than one hour; normal runs finish in minutes.
    await database.db
      .update(normalizationRuns)
      .set({
        status: 'failed',
        errorSummary: 'stale fixture normalization run reclaimed by a retry',
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
        throw new Error('existing source upload record does not match the fixture source');
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
      [join(REPO_ROOT, 'tools/normalize_fixed_epub.py'), sourcePath, packageDir],
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
    const validationOutput = await runCommand(
      'python3',
      [join(REPO_ROOT, 'tools/nb_check.py'), normalizedHtml, '--baseline', sourcePath],
      { cwd: REPO_ROOT, allowedExitCodes: [0, 2] },
    );
    await writeFile(join(packageDir, 'validation_report.txt'), validationOutput, 'utf8');

    const normalizationReport = JSON.parse(
      await readFile(join(packageDir, 'normalization_report.json'), 'utf8'),
    ) as NormalizationReport;
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ReadingManifest;
    if (manifest.version !== MANIFEST_VERSION) {
      throw new Error(`unexpected manifest version: ${manifest.version}`);
    }
    const bookProfile = createBookProfile(manifest);
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
      'validation_report.txt',
    ];
    for (const name of required) {
      if (!files.includes(name)) {
        throw new Error(`normalized package is missing required file: ${name}`);
      }
    }

    const objectPrefix = `books/${epubSha256}/packages/${PACKAGE_VERSION}`;
    const fileHashes: Record<string, string> = {};
    for (const file of files) {
      const bytes = await readFile(join(packageDir, file));
      fileHashes[file] = sha256(bytes);
      await putImmutable(storage, `${objectPrefix}/${file}`, bytes, contentType(file));
    }

    const proposedPackageId = randomUUID();
    const profileBytes = await readFile(join(packageDir, 'book_profile.json'));
    const metadata = normalizationReport.metadata;
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
            validator: 'nb_check.py',
            baselineSha256: epubSha256,
            acceptedExitCodes: [0, 2],
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
