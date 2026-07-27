/**
 * Preset 导入的数据库适配：在单个事务中创建 shared book、package、profile 并切换为 ready。
 */
import { inArray, sql } from 'drizzle-orm';
import {
  bookPackages,
  bookProfiles,
  sharedBooks,
  type Database,
} from '@readtailor/database';
import {
  PRESET_CONTRACT_VERSION,
  PRESET_IMPORTER_VERSION,
  PRESET_MANIFEST_VERSION,
  PRESET_PACKAGE_VERSION,
  type PresetImportRepository,
} from './importer';

export function createPresetImportRepository(db: Database): PresetImportRepository {
  return {
    async findExistingBooks(epubSha256) {
      if (epubSha256.length === 0) return [];
      return db
        .select({
          id: sharedBooks.id,
          epubSha256: sharedBooks.epubSha256,
          status: sharedBooks.status,
          isPreset: sharedBooks.isPreset,
        })
        .from(sharedBooks)
        .where(inArray(sharedBooks.epubSha256, epubSha256));
    },

    async insertReadyPresetBook(input) {
      await db.transaction(async (tx) => {
        await tx.insert(sharedBooks).values({
          id: input.bookId,
          epubSha256: input.epubSha256,
          status: 'queued',
          title: input.metadata.title,
          authors: input.metadata.authors,
          language: input.metadata.language,
          coverPath: input.metadata.cover_path,
          identifiers: input.metadata.identifiers,
          publisher: input.metadata.publisher,
          publishedDate: input.metadata.published_date,
          sourceFilename: input.metadata.source_filename,
          isPreset: false,
        });
        await tx.insert(bookPackages).values({
          id: input.packageId,
          sharedBookId: input.bookId,
          version: PRESET_PACKAGE_VERSION,
          contractVersion: PRESET_CONTRACT_VERSION,
          manifestVersion: PRESET_MANIFEST_VERSION,
          objectPrefix: input.objectPrefix,
          fileHashes: input.publication.fileHashes,
          validationSummary: {
            importer: PRESET_IMPORTER_VERSION,
            sourceEpubSha256: input.epubSha256,
            packageInventorySha256: input.publication.inventorySha256,
            validatorVersion: input.validation.validatorVersion,
            validationReportSha256: input.validation.validationReportSha256,
            blockingErrorCount: input.validation.blockingErrorCount,
            warningCount: input.validation.warningCount,
          },
        });
        await tx.insert(bookProfiles).values({
          id: input.profileId,
          packageId: input.packageId,
          objectKey: `${input.objectPrefix}/book_profile.json`,
          sha256: input.profileSha256,
        });
        await tx
          .update(sharedBooks)
          .set({
            status: 'ready',
            currentPackageId: input.packageId,
            isPreset: true,
            errorSummary: null,
            failureType: null,
            updatedAt: sql`now()`,
          })
          .where(inArray(sharedBooks.id, [input.bookId]));
      });
    },
  };
}
