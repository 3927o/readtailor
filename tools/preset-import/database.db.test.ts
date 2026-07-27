/**
 * Preset repository 的数据库契约测试：确认单事务只创建共享书、package 和 profile。
 */
import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  bookPackages,
  bookProfiles,
  normalizationRuns,
  sharedBooks,
  sourceUploads,
} from '@readtailor/database';
import {
  getTestDatabase,
  hasTestDatabase,
} from '../../apps/api/src/test/database';
import {
  PRESET_CONTRACT_VERSION,
  PRESET_MANIFEST_VERSION,
  PRESET_PACKAGE_VERSION,
  type ReadyPresetBookInsert,
} from './importer';
import { createPresetImportRepository } from './database';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function insertPayload(
  objectPrefix = `preset-test/${randomUUID()}`,
): ReadyPresetBookInsert {
  const bookId = randomUUID();
  const profileSha256 = hash(`profile:${bookId}`);
  return {
    bookId,
    packageId: randomUUID(),
    profileId: randomUUID(),
    epubSha256: hash(`epub:${bookId}`),
    metadata: {
      title: `Preset ${bookId}`,
      authors: ['Author'],
      language: 'zh-CN',
      cover_path: 'assets/cover.png',
      identifiers: {},
      publisher: null,
      published_date: null,
      source_filename: `${bookId}.epub`,
    },
    objectPrefix,
    publication: {
      objectPrefix,
      inventory: {
        version: 'artifact-inventory-1.0',
        files: [],
      },
      inventorySha256: hash(`inventory:${bookId}`),
      fileHashes: {
        'book_profile.json': profileSha256,
      },
    },
    profileSha256,
    validation: {
      validatorVersion: 'nb-check-test',
      blockingErrorCount: 0,
      warningCount: 1,
      validationReportSha256: hash(`validation:${bookId}`),
    },
  };
}

describePostgres(`preset import repository${skipReason}`, () => {
  it('creates a ready preset without upload or normalization rows', async () => {
    const db = getTestDatabase().db;
    const repository = createPresetImportRepository(db);
    const input = insertPayload();

    await repository.insertReadyPresetBook(input);

    const [book] = await db
      .select()
      .from(sharedBooks)
      .where(eq(sharedBooks.id, input.bookId));
    const [bookPackage] = await db
      .select()
      .from(bookPackages)
      .where(eq(bookPackages.id, input.packageId));
    const [profile] = await db
      .select()
      .from(bookProfiles)
      .where(eq(bookProfiles.id, input.profileId));
    const uploads = await db
      .select()
      .from(sourceUploads)
      .where(eq(sourceUploads.sharedBookId, input.bookId));
    const runs = await db
      .select()
      .from(normalizationRuns)
      .where(eq(normalizationRuns.sharedBookId, input.bookId));

    expect(book).toEqual(expect.objectContaining({
      status: 'ready',
      isPreset: true,
      currentPackageId: input.packageId,
      epubSha256: input.epubSha256,
    }));
    expect(bookPackage).toEqual(expect.objectContaining({
      version: PRESET_PACKAGE_VERSION,
      contractVersion: PRESET_CONTRACT_VERSION,
      manifestVersion: PRESET_MANIFEST_VERSION,
      producerAttemptId: null,
      packageManifestObjectKey: null,
      packageManifestSha256: null,
    }));
    expect(profile).toEqual(expect.objectContaining({
      packageId: input.packageId,
      objectKey: `${input.objectPrefix}/book_profile.json`,
      sha256: input.profileSha256,
    }));
    expect(uploads).toEqual([]);
    expect(runs).toEqual([]);
  });

  it('rolls back the shared book when a later package insert fails', async () => {
    const db = getTestDatabase().db;
    const repository = createPresetImportRepository(db);
    const first = insertPayload();
    await repository.insertReadyPresetBook(first);
    const conflicting = insertPayload(first.objectPrefix);

    await expect(repository.insertReadyPresetBook(conflicting)).rejects.toThrow();

    expect(await db
      .select()
      .from(sharedBooks)
      .where(eq(sharedBooks.id, conflicting.bookId))).toEqual([]);
  });
});
