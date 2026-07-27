/**
 * Preset 导入工具的边界测试：覆盖目录契约、全量预检、重复 SHA 只读跳过和成功发布。
 */
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import manifestFixture from '../../packages/reader-core/src/fixtures/reading-nodes-1.0.valid.json';
import { FileSystemObjectStorage, type ObjectStorage } from '@readtailor/storage';
import {
  PRESET_PACKAGE_VERSION,
  importPresetBooks,
  preflightPresetBook,
  scanPresetBookDirectory,
  type ExistingBook,
  type PresetImportRepository,
  type ReadyPresetBookInsert,
} from './importer';
import { sha256 } from '@readtailor/normalized-book';

const temporaryDirectories: string[] = [];

type PackagePaths = {
  html: string;
  manifest: string;
  profile: string;
  metadata: string;
  normalization: string;
  validationText: string;
  validationJson: string;
  cover: string;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function bookProfile() {
  const eligible = manifestFixture.nodes.filter((node) => node.tailoringEligible);
  return {
    version: 'book-profile-1.0',
    summary: '这是一段足够长的书籍摘要，用于验证导入器能够接受完整的共享书籍分析结果。',
    structure: '这是一段足够长的结构描述，用于说明章节组织以及各部分之间的关系。',
    core_questions: ['这本书试图回答什么核心问题？'],
    themes: ['主题'],
    reading_barriers: ['读者可能缺少作品涉及的历史背景知识。'],
    reading_advice: ['阅读时先把握章节结构，再处理局部概念。'],
    trial_candidates: eligible.map((node) => ({
      section_id: node.sectionId,
      segment: node.segment,
      features: ['representative'],
      reason: '该节点具有代表性，适合用于阅读设置。',
    })),
  };
}

async function createBook(
  root: string,
  name: string,
  epub = `epub:${name}`,
): Promise<{
  directory: string;
  packageDirectory: string;
  epubPath: string;
  paths: PackagePaths;
}> {
  const directory = join(root, name);
  const packageDirectory = join(directory, 'package');
  const assetsDirectory = join(packageDirectory, 'assets');
  await mkdir(assetsDirectory, { recursive: true });
  const epubPath = join(directory, `${name}.epub`);
  const epubBytes = Buffer.from(epub);
  const htmlBytes = Buffer.from('<!doctype html><html><body><p>book</p></body></html>\n');
  const paths = {
    html: join(packageDirectory, 'book.normalized.html'),
    manifest: join(packageDirectory, 'reading_manifest.json'),
    profile: join(packageDirectory, 'book_profile.json'),
    metadata: join(packageDirectory, 'metadata.json'),
    normalization: join(packageDirectory, 'normalization_report.json'),
    validationText: join(packageDirectory, 'validation_report.txt'),
    validationJson: join(packageDirectory, 'validation_report.json'),
    cover: join(assetsDirectory, 'cover.png'),
  };
  await Promise.all([
    writeFile(epubPath, epubBytes),
    writeFile(paths.html, htmlBytes),
    writeFile(paths.manifest, `${JSON.stringify(manifestFixture, null, 2)}\n`),
    writeFile(paths.profile, `${JSON.stringify(bookProfile(), null, 2)}\n`),
    writeFile(
      paths.metadata,
      `${JSON.stringify({
        title: name,
        authors: ['Author'],
        language: 'zh-CN',
        cover_path: 'assets/cover.png',
        identifiers: {},
        publisher: null,
        published_date: null,
        source_filename: `${name}.epub`,
      }, null, 2)}\n`,
    ),
    writeFile(
      paths.normalization,
      `${JSON.stringify({
        normalized_spec: 'nb-1.0',
        source: { filename: `${name}.epub`, sha256: sha256(epubBytes) },
        output: { html: 'book.normalized.html', html_sha256: sha256(htmlBytes) },
      }, null, 2)}\n`,
    ),
    writeFile(paths.validationText, 'validation passed\n'),
    writeFile(
      paths.validationJson,
      `${JSON.stringify({
        version: 'nb-check-1.0',
        totals: { errors: 0, warnings: 0 },
        sections: {},
      }, null, 2)}\n`,
    ),
    writeFile(paths.cover, Buffer.from([1, 2, 3])),
  ]);
  return { directory, packageDirectory, epubPath, paths };
}

class MemoryRepository implements PresetImportRepository {
  readonly inserted: ReadyPresetBookInsert[] = [];

  constructor(readonly existing: ExistingBook[] = []) {}

  async findExistingBooks(epubSha256: string[]): Promise<ExistingBook[]> {
    return this.existing.filter((book) => epubSha256.includes(book.epubSha256));
  }

  async insertReadyPresetBook(input: ReadyPresetBookInsert): Promise<void> {
    this.inserted.push(input);
  }
}

class CountingStorage implements ObjectStorage {
  readonly objects = new Map<string, Uint8Array>();
  putCount = 0;

  async put(key: string, body: Uint8Array) {
    this.putCount += 1;
    this.objects.set(key, body);
    return { key, size: body.byteLength };
  }

  async putIfAbsent(key: string, body: Uint8Array) {
    this.putCount += 1;
    const existing = this.objects.get(key);
    if (existing) return { created: false, object: { key, size: existing.byteLength } };
    this.objects.set(key, body);
    return { created: true, object: { key, size: body.byteLength } };
  }

  async get(key: string) {
    const body = this.objects.get(key);
    if (!body) throw new Error(`missing object: ${key}`);
    return body;
  }

  async head(key: string) {
    const body = this.objects.get(key);
    return body ? { key, size: body.byteLength } : undefined;
  }

  async delete(key: string) {
    this.objects.delete(key);
  }

  async list(prefix: string) {
    return [...this.objects]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => ({ key, size: body.byteLength }));
  }
}

describe('preset book directory scan', () => {
  it('sorts direct book directories and computes EPUB SHA-256', async () => {
    const root = await temporaryDirectory('preset-scan-');
    await createBook(root, 'zeta');
    await createBook(root, 'alpha');

    const candidates = await scanPresetBookDirectory(root);

    expect(candidates.map((candidate) => candidate.name)).toEqual(['alpha', 'zeta']);
    expect(candidates[0]?.epubSha256).toBe(sha256(Buffer.from('epub:alpha')));
  });

  it('rejects extra per-book files and duplicate EPUB content', async () => {
    const rootWithExtra = await temporaryDirectory('preset-extra-');
    const book = await createBook(rootWithExtra, 'book');
    await writeFile(join(book.directory, 'preset.json'), '{}');
    await expect(scanPresetBookDirectory(rootWithExtra)).rejects.toThrow(
      'must contain exactly book.epub and package/',
    );

    const duplicateRoot = await temporaryDirectory('preset-duplicate-');
    await createBook(duplicateRoot, 'one', 'same epub');
    await createBook(duplicateRoot, 'two', 'same epub');
    await expect(scanPresetBookDirectory(duplicateRoot)).rejects.toThrow(
      'contain the same EPUB SHA-256',
    );
  });
});

describe('preset package preflight', () => {
  it('accepts a complete package', async () => {
    const root = await temporaryDirectory('preset-valid-');
    await createBook(root, 'book');
    const [candidate] = await scanPresetBookDirectory(root);
    if (!candidate) throw new Error('candidate missing');

    const result = await preflightPresetBook(candidate);

    expect(result.metadata.title).toBe('book');
    expect(result.validation.blockingErrorCount).toBe(0);
    expect(result.inventory.files.map((file) => file.path)).toContain('assets/cover.png');
  });

  it.each([
    [
      'normalization source SHA',
      async (paths: PackagePaths) => {
        const report = JSON.parse(await readFile(paths.normalization, 'utf8'));
        report.source.sha256 = '0'.repeat(64);
        await writeFile(paths.normalization, JSON.stringify(report));
      },
      'source SHA-256 does not match EPUB',
    ],
    [
      'manifest',
      async (paths: PackagePaths) => {
        const manifest = JSON.parse(await readFile(paths.manifest, 'utf8'));
        manifest.version = 'reading-nodes-2.0';
        await writeFile(paths.manifest, JSON.stringify(manifest));
      },
      'unsupported reading manifest version',
    ],
    [
      'book profile',
      async (paths: PackagePaths) => {
        const profile = JSON.parse(await readFile(paths.profile, 'utf8'));
        profile.trial_candidates[0].section_id = 'missing';
        await writeFile(paths.profile, JSON.stringify(profile));
      },
      'not tailoring eligible',
    ],
    [
      'cover',
      async (paths: PackagePaths) => {
        const metadata = JSON.parse(await readFile(paths.metadata, 'utf8'));
        metadata.cover_path = '../cover.png';
        await writeFile(paths.metadata, JSON.stringify(metadata));
      },
      'unsafe package path',
    ],
    [
      'blocking validation',
      async (paths: PackagePaths) => {
        const validation = JSON.parse(await readFile(paths.validationJson, 'utf8'));
        validation.totals.errors = 1;
        await writeFile(paths.validationJson, JSON.stringify(validation));
      },
      'has 1 blocking errors',
    ],
  ])('rejects an invalid %s', async (_name, mutate, expected) => {
    const root = await temporaryDirectory('preset-invalid-');
    const book = await createBook(root, 'book');
    await mutate(book.paths);
    const [candidate] = await scanPresetBookDirectory(root);
    if (!candidate) throw new Error('candidate missing');
    await expect(preflightPresetBook(candidate)).rejects.toThrow(expected);
  });

  it('rejects unsafe package filesystem entries', async () => {
    const root = await temporaryDirectory('preset-symlink-');
    const book = await createBook(root, 'book');
    await symlink(book.paths.cover, join(book.packageDirectory, 'assets', 'alias.png'));
    const [candidate] = await scanPresetBookDirectory(root);
    if (!candidate) throw new Error('candidate missing');

    await expect(preflightPresetBook(candidate)).rejects.toThrow(
      'package must not contain symbolic links',
    );
  });
});

describe('preset import orchestration', () => {
  it('skips an existing EPUB before any storage write and does not change isPreset', async () => {
    const root = await temporaryDirectory('preset-skip-');
    const book = await createBook(root, 'book');
    const epubSha256 = sha256(await readFile(book.epubPath));
    const repository = new MemoryRepository([{
      id: 'existing-book',
      epubSha256,
      status: 'failed',
      isPreset: false,
    }]);
    const storage = new CountingStorage();
    const warnings: string[] = [];

    const result = await importPresetBooks({
      rootDirectory: root,
      repository,
      storage,
      logger: { info() {}, warn: (message) => warnings.push(message) },
    });

    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ id: 'existing-book', isPreset: false, status: 'failed' }),
    ]);
    expect(repository.inserted).toEqual([]);
    expect(storage.putCount).toBe(0);
    expect(warnings[0]).toContain('isPreset=false');
  });

  it('preflights every pending book before the first upload', async () => {
    const root = await temporaryDirectory('preset-all-preflight-');
    await createBook(root, 'a-valid');
    const invalid = await createBook(root, 'z-invalid');
    const validation = JSON.parse(await readFile(invalid.paths.validationJson, 'utf8'));
    validation.totals.errors = 1;
    await writeFile(invalid.paths.validationJson, JSON.stringify(validation));
    const storage = new CountingStorage();

    await expect(importPresetBooks({
      rootDirectory: root,
      repository: new MemoryRepository(),
      storage,
    })).rejects.toThrow('has 1 blocking errors');
    expect(storage.putCount).toBe(0);
  });

  it('publishes every file and passes one ready-book transaction payload to the repository', async () => {
    const root = await temporaryDirectory('preset-success-');
    await createBook(root, 'book');
    const storageRoot = await temporaryDirectory('preset-storage-');
    const storage = new FileSystemObjectStorage(storageRoot);
    const repository = new MemoryRepository();

    const result = await importPresetBooks({
      rootDirectory: root,
      repository,
      storage,
      logger: { info() {}, warn() {} },
    });

    expect(result.imported).toHaveLength(1);
    expect(repository.inserted).toHaveLength(1);
    const inserted = repository.inserted[0];
    expect(inserted?.objectPrefix).toContain(`/packages/${PRESET_PACKAGE_VERSION}/`);
    expect(inserted?.publication.fileHashes).toHaveProperty('book.normalized.html');
    expect(inserted?.publication.fileHashes).toHaveProperty('validation_report.json');
    const objects = await storage.list(inserted?.objectPrefix ?? '');
    expect(objects).toHaveLength(inserted?.publication.inventory.files.length ?? 0);
    for (const file of inserted?.publication.inventory.files ?? []) {
      const bytes = await storage.get(`${inserted?.objectPrefix}/${file.path}`);
      expect(sha256(bytes)).toBe(file.sha256);
    }
  });
});
