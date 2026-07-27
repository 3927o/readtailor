/**
 * Preset package 导入核心：目录扫描、全量预检、重复判断和不可变对象发布编排。
 *
 * 本模块不读取环境变量、不创建数据库连接；EPUB 只用于内容寻址和校验，不会上传。
 */
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  assertRequiredArtifacts,
  assertSafeRelativePath,
  buildArtifactInventory,
  hashArtifactInventory,
  publishImmutablePackage,
  readBookMetadata,
  sha256,
  validateReadingManifestForPublication,
  type ArtifactInventory,
  type BookMetadata,
  type ImmutablePublicationReceipt,
} from '@readtailor/normalized-book';
import {
  createManifestIndex,
  findNode,
  type ReadingManifest,
} from '@readtailor/reader-core';
import type { ObjectStorage } from '@readtailor/storage';

export const PRESET_PACKAGE_VERSION = 'nb-1.0-preset-v1';
export const PRESET_CONTRACT_VERSION = 'nb-1.0';
export const PRESET_MANIFEST_VERSION = 'reading-nodes-1.0';
export const PRESET_IMPORTER_VERSION = 'preset-importer-1.0';

const REQUIRED_PACKAGE_FILES = [
  'book.normalized.html',
  'reading_manifest.json',
  'book_profile.json',
  'metadata.json',
  'normalization_report.json',
  'validation_report.txt',
  'validation_report.json',
] as const;
const MAX_EPUB_BYTES = 512 * 1024 * 1024;
const MAX_PROFILE_BYTES = 50_000;

type SharedBookStatus =
  | 'queued'
  | 'normalizing'
  | 'validating'
  | 'indexing'
  | 'analyzing'
  | 'ready'
  | 'failed';

export type ExistingBook = {
  id: string;
  epubSha256: string;
  status: SharedBookStatus;
  isPreset: boolean;
};

export type PresetBookCandidate = {
  name: string;
  directory: string;
  epubPath: string;
  packageDirectory: string;
  epubSha256: string;
};

export type PreflightedPresetBook = PresetBookCandidate & {
  inventory: ArtifactInventory;
  inventorySha256: string;
  metadata: BookMetadata;
  manifest: ReadingManifest;
  profileSha256: string;
  validation: {
    validatorVersion: string;
    blockingErrorCount: 0;
    warningCount: number;
    validationReportSha256: string;
  };
};

export type ReadyPresetBookInsert = {
  bookId: string;
  packageId: string;
  profileId: string;
  epubSha256: string;
  metadata: BookMetadata;
  objectPrefix: string;
  publication: ImmutablePublicationReceipt;
  profileSha256: string;
  validation: PreflightedPresetBook['validation'];
};

export interface PresetImportRepository {
  findExistingBooks(epubSha256: string[]): Promise<ExistingBook[]>;
  insertReadyPresetBook(input: ReadyPresetBookInsert): Promise<void>;
}

export type PresetImportLogger = {
  info(message: string): void;
  warn(message: string): void;
};

export type PresetImportResult = {
  imported: Array<{ name: string; bookId: string; packageId: string }>;
  skipped: Array<ExistingBook & { name: string }>;
};

type NormalizationReport = {
  normalized_spec?: unknown;
  source?: { sha256?: unknown };
  output?: { html_sha256?: unknown };
};

type StructuredValidationReport = {
  version?: unknown;
  totals?: { errors?: unknown; warnings?: unknown };
};

type BookProfile = {
  version?: unknown;
  summary?: unknown;
  structure?: unknown;
  core_questions?: unknown;
  themes?: unknown;
  reading_barriers?: unknown;
  reading_advice?: unknown;
  trial_candidates?: unknown;
};

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

function nonEmptyStrings(
  value: unknown,
  options: { minLength?: number } = {},
): value is string[] {
  const minLength = options.minLength ?? 1;
  return (
    Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === 'string' && item.trim().length >= minLength)
  );
}

function validateBookProfile(value: unknown, manifest: ReadingManifest): void {
  if (!value || typeof value !== 'object') {
    throw new Error('book_profile.json must contain an object');
  }
  const profile = value as BookProfile;
  if (profile.version !== 'book-profile-1.0') {
    throw new Error('book_profile.json version must be book-profile-1.0');
  }
  if (typeof profile.summary !== 'string' || profile.summary.trim().length < 20) {
    throw new Error('book_profile.json summary is missing or too short');
  }
  if (typeof profile.structure !== 'string' || profile.structure.trim().length < 20) {
    throw new Error('book_profile.json structure is missing or too short');
  }
  for (const [field, minLength] of [
    ['core_questions', 5],
    ['themes', 1],
    ['reading_barriers', 5],
    ['reading_advice', 5],
  ] as const) {
    if (!nonEmptyStrings(profile[field], { minLength })) {
      throw new Error(`book_profile.json ${field} must be a non-empty string array`);
    }
  }

  const eligible = new Set(
    manifest.nodes
      .filter((node) => node.tailoringEligible)
      .map((node) => `${node.sectionId}\0${node.segment}`),
  );
  if (eligible.size === 0) {
    throw new Error('book_profile.json requires at least one tailoring-eligible manifest node');
  }
  if (!Array.isArray(profile.trial_candidates)) {
    throw new Error('book_profile.json trial_candidates must be an array');
  }
  const minimumCandidates = Math.min(9, eligible.size);
  const maximumCandidates = Math.min(15, eligible.size);
  if (
    profile.trial_candidates.length < minimumCandidates
    || profile.trial_candidates.length > maximumCandidates
  ) {
    throw new Error(
      `book_profile.json requires ${minimumCandidates}-${maximumCandidates} trial candidates`,
    );
  }

  const manifestIndex = createManifestIndex(manifest);
  const seen = new Set<string>();
  for (const [index, rawCandidate] of profile.trial_candidates.entries()) {
    if (!rawCandidate || typeof rawCandidate !== 'object') {
      throw new Error(`book_profile.json trial_candidates[${index}] is invalid`);
    }
    const candidate = rawCandidate as Record<string, unknown>;
    const sectionId = candidate.section_id;
    const segment = candidate.segment;
    if (typeof sectionId !== 'string' || !sectionId || !Number.isInteger(segment) || Number(segment) < 1) {
      throw new Error(`book_profile.json trial_candidates[${index}] has an invalid node key`);
    }
    const key = `${sectionId}\0${String(segment)}`;
    if (
      !eligible.has(key)
      || !findNode(manifestIndex, sectionId, Number(segment))?.tailoringEligible
    ) {
      throw new Error(`book_profile.json trial candidate is not tailoring eligible: ${key}`);
    }
    if (seen.has(key)) {
      throw new Error(`book_profile.json contains a duplicate trial candidate: ${key}`);
    }
    seen.add(key);
    if (!nonEmptyStrings(candidate.features)) {
      throw new Error(`book_profile.json trial_candidates[${index}] needs features`);
    }
    if (typeof candidate.reason !== 'string' || candidate.reason.trim().length < 5) {
      throw new Error(`book_profile.json trial_candidates[${index}] needs a reason`);
    }
  }
}

async function requireDirectory(path: string, label: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${label} is missing or is not a directory: ${path}`);
}

/**
 * 只接受 `<root>/<book>/<book>.epub + package/`。结构错误在连接对象存储前即可发现。
 */
export async function scanPresetBookDirectory(rootDirectory: string): Promise<PresetBookCandidate[]> {
  const root = resolve(rootDirectory);
  await requireDirectory(root, 'preset book root');
  const rootEntries = await readdir(root, { withFileTypes: true });
  const visibleEntries = rootEntries.filter((entry) => entry.name !== '.DS_Store');
  if (visibleEntries.length === 0) throw new Error(`preset book root is empty: ${root}`);

  const candidates: PresetBookCandidate[] = [];
  for (const entry of visibleEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`preset book root may only contain book directories: ${entry.name}`);
    }
    const directory = join(root, entry.name);
    const bookEntries = (await readdir(directory, { withFileTypes: true }))
      .filter((child) => child.name !== '.DS_Store')
      .sort((left, right) => left.name.localeCompare(right.name));
    const expectedNames = [`${entry.name}.epub`, 'package'].sort();
    if (
      bookEntries.length !== 2
      || bookEntries.some((child, index) => child.name !== expectedNames[index])
    ) {
      throw new Error(
        `${entry.name} must contain exactly ${entry.name}.epub and package/`,
      );
    }
    const epubEntry = bookEntries.find((child) => child.name === `${entry.name}.epub`);
    const packageEntry = bookEntries.find((child) => child.name === 'package');
    if (
      !epubEntry?.isFile()
      || epubEntry.isSymbolicLink()
      || !packageEntry?.isDirectory()
      || packageEntry.isSymbolicLink()
    ) {
      throw new Error(`${entry.name} has an invalid EPUB or package filesystem entry`);
    }
    const epubPath = join(directory, `${entry.name}.epub`);
    const epubInfo = await stat(epubPath);
    if (epubInfo.size === 0 || epubInfo.size > MAX_EPUB_BYTES) {
      throw new Error(`${entry.name}.epub must be between 1 and ${MAX_EPUB_BYTES} bytes`);
    }
    const packageDirectory = join(directory, 'package');
    await requireDirectory(join(packageDirectory, 'assets'), `${entry.name} package assets`);
    candidates.push({
      name: entry.name,
      directory,
      epubPath,
      packageDirectory,
      epubSha256: sha256(await readFile(epubPath)),
    });
  }

  const bySha = new Map<string, string>();
  for (const candidate of candidates) {
    const duplicateName = bySha.get(candidate.epubSha256);
    if (duplicateName) {
      throw new Error(
        `${candidate.name} and ${duplicateName} contain the same EPUB SHA-256 ${candidate.epubSha256}`,
      );
    }
    bySha.set(candidate.epubSha256, candidate.name);
  }
  return candidates;
}

/**
 * 对所有即将导入的书做完整、只读预检。调用方必须在全部成功后才能开始发布。
 */
export async function preflightPresetBook(
  candidate: PresetBookCandidate,
): Promise<PreflightedPresetBook> {
  const inventory = await buildArtifactInventory(candidate.packageDirectory);
  assertRequiredArtifacts(inventory, REQUIRED_PACKAGE_FILES);
  const inventoryByPath = new Map(inventory.files.map((entry) => [entry.path, entry] as const));
  for (const entry of inventory.files) {
    if (
      !REQUIRED_PACKAGE_FILES.includes(entry.path as (typeof REQUIRED_PACKAGE_FILES)[number])
      && !entry.path.startsWith('assets/')
    ) {
      throw new Error(`${candidate.name} package contains an unsupported file: ${entry.path}`);
    }
  }

  const metadata = await readBookMetadata(candidate.packageDirectory);
  if (metadata.source_filename !== basename(candidate.epubPath)) {
    throw new Error(
      `${candidate.name} metadata source_filename must equal ${basename(candidate.epubPath)}`,
    );
  }
  if (metadata.cover_path) {
    const coverPath = assertSafeRelativePath(metadata.cover_path);
    if (!coverPath.startsWith('assets/') || !inventoryByPath.has(coverPath)) {
      throw new Error(`${candidate.name} metadata cover_path must reference an assets/ file`);
    }
    metadata.cover_path = coverPath;
  }

  const manifestRaw = await readFile(
    join(candidate.packageDirectory, 'reading_manifest.json'),
    'utf8',
  );
  const manifest = validateReadingManifestForPublication(
    manifestRaw,
    PRESET_MANIFEST_VERSION,
  );

  const profilePath = join(candidate.packageDirectory, 'book_profile.json');
  const profileBytes = await readFile(profilePath);
  if (profileBytes.byteLength > MAX_PROFILE_BYTES) {
    throw new Error(`${candidate.name} book_profile.json exceeds ${MAX_PROFILE_BYTES} bytes`);
  }
  validateBookProfile(parseJson(profileBytes.toString('utf8'), profilePath), manifest);

  const normalizationPath = join(candidate.packageDirectory, 'normalization_report.json');
  const normalization = parseJson(
    await readFile(normalizationPath, 'utf8'),
    normalizationPath,
  ) as NormalizationReport;
  if (normalization.normalized_spec !== PRESET_CONTRACT_VERSION) {
    throw new Error(`${candidate.name} normalization report must target ${PRESET_CONTRACT_VERSION}`);
  }
  if (normalization.source?.sha256 !== candidate.epubSha256) {
    throw new Error(`${candidate.name} normalization report source SHA-256 does not match EPUB`);
  }
  if (
    normalization.output?.html_sha256
    !== inventoryByPath.get('book.normalized.html')?.sha256
  ) {
    throw new Error(`${candidate.name} normalization report HTML SHA-256 is invalid`);
  }

  const validationPath = join(candidate.packageDirectory, 'validation_report.json');
  const validationBytes = await readFile(validationPath);
  const validationReport = parseJson(
    validationBytes.toString('utf8'),
    validationPath,
  ) as StructuredValidationReport;
  const validationTotals = validationReport.totals;
  if (
    typeof validationReport.version !== 'string'
    || !validationReport.version
    || !validationTotals
    || !Number.isInteger(validationTotals.errors)
    || !Number.isInteger(validationTotals.warnings)
    || Number(validationTotals.warnings) < 0
  ) {
    throw new Error(`${candidate.name} validation_report.json has an invalid summary`);
  }
  if (validationTotals.errors !== 0) {
    throw new Error(
      `${candidate.name} validation_report.json has ${String(validationTotals.errors)} blocking errors`,
    );
  }
  const humanValidation = await readFile(
    join(candidate.packageDirectory, 'validation_report.txt'),
    'utf8',
  );
  if (!humanValidation.trim()) {
    throw new Error(`${candidate.name} validation_report.txt is empty`);
  }

  return {
    ...candidate,
    inventory,
    inventorySha256: hashArtifactInventory(inventory),
    metadata,
    manifest,
    profileSha256: sha256(profileBytes),
    validation: {
      validatorVersion: validationReport.version,
      blockingErrorCount: 0,
      warningCount: Number(validationTotals.warnings),
      validationReportSha256: sha256(validationBytes),
    },
  };
}

/**
 * 先查重、再全量预检，最后逐书发布。外部失败会停止后续书籍，已完成事务保持可重跑。
 */
export async function importPresetBooks(options: {
  rootDirectory: string;
  repository: PresetImportRepository;
  storage: ObjectStorage;
  logger?: PresetImportLogger;
}): Promise<PresetImportResult> {
  const logger = options.logger ?? console;
  const candidates = await scanPresetBookDirectory(options.rootDirectory);
  const existingBooks = await options.repository.findExistingBooks(
    candidates.map((candidate) => candidate.epubSha256),
  );
  const existingBySha = new Map(existingBooks.map((book) => [book.epubSha256, book] as const));
  const skipped: PresetImportResult['skipped'] = [];
  const pending: PresetBookCandidate[] = [];

  for (const candidate of candidates) {
    const existing = existingBySha.get(candidate.epubSha256);
    if (existing) {
      skipped.push({ ...existing, name: candidate.name });
      logger.warn(
        `⚠️  [SKIPPED] ${candidate.name}: EPUB SHA-256 already exists; `
        + `bookId=${existing.id} status=${existing.status} isPreset=${String(existing.isPreset)}. `
        + 'No objects or database rows were changed.',
      );
    } else {
      pending.push(candidate);
    }
  }

  const preflighted = await Promise.all(pending.map(preflightPresetBook));
  const imported: PresetImportResult['imported'] = [];
  for (const book of preflighted) {
    const objectPrefix = [
      'books',
      book.epubSha256,
      'packages',
      PRESET_PACKAGE_VERSION,
      book.inventorySha256,
    ].join('/');
    const publication = await publishImmutablePackage({
      storage: options.storage,
      packageDirectory: book.packageDirectory,
      objectPrefix,
      requiredFiles: REQUIRED_PACKAGE_FILES,
    });
    if (publication.inventorySha256 !== book.inventorySha256) {
      throw new Error(`${book.name} package changed between preflight and publication`);
    }

    const bookId = randomUUID();
    const packageId = randomUUID();
    await options.repository.insertReadyPresetBook({
      bookId,
      packageId,
      profileId: randomUUID(),
      epubSha256: book.epubSha256,
      metadata: book.metadata,
      objectPrefix,
      publication,
      profileSha256: book.profileSha256,
      validation: book.validation,
    });
    imported.push({ name: book.name, bookId, packageId });
    logger.info(
      `[IMPORTED] ${book.name}: bookId=${bookId} packageId=${packageId} objectPrefix=${objectPrefix}`,
    );
  }
  return { imported, skipped };
}
