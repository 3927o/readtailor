/** Loads the persisted book, profile, manifest, and normalized source used by reading-setup tools. */

import { and, eq } from 'drizzle-orm';
import {
  bookPackages,
  bookProfiles,
  readerProfiles,
  readerProfileVersions,
  sharedBooks,
  userBooks,
  type Database,
} from '@readtailor/database';
import type { ReadingManifest } from '@readtailor/reader-core';
import type { ObjectStorage } from '@readtailor/storage';
import type { JsonValue } from '@readtailor/tailoring';
import { readPublishedReadingManifestJson } from '../reading-manifest';

export interface ReadingSetupAgentResources {
  userBook: typeof userBooks.$inferSelect;
  sharedBook: typeof sharedBooks.$inferSelect;
  package: typeof bookPackages.$inferSelect;
  readerProfile: typeof readerProfileVersions.$inferSelect | null;
  bookProfile: JsonValue;
  rawHtml: string;
  manifest: ReadingManifest;
}

export async function loadReadingSetupAgentResources(options: {
  db: Database;
  storage: ObjectStorage;
  userBookId: string;
}): Promise<ReadingSetupAgentResources> {
  const [row] = await options.db
    .select({ userBook: userBooks, sharedBook: sharedBooks, package: bookPackages })
    .from(userBooks)
    .innerJoin(sharedBooks, eq(sharedBooks.id, userBooks.sharedBookId))
    .innerJoin(bookPackages, eq(bookPackages.id, sharedBooks.currentPackageId))
    .where(and(eq(userBooks.id, options.userBookId), eq(sharedBooks.status, 'ready')))
    .limit(1);
  if (
    !row ||
    row.userBook.deletedAt ||
    (
      row.userBook.workflowStatus !== 'on_shelf' &&
      row.userBook.workflowStatus !== 'active_reading'
    )
  ) {
    throw new Error('阅读准备资源当前不可用');
  }

  const [readerProfile, htmlBytes, manifestBytes, bookProfileRow] = await Promise.all([
    options.db
      .select({ version: readerProfileVersions })
      .from(readerProfiles)
      .innerJoin(readerProfileVersions, eq(readerProfileVersions.id, readerProfiles.currentVersionId))
      .where(eq(readerProfiles.userId, row.userBook.userId))
      .limit(1)
      .then((items) => items[0]?.version ?? null),
    options.storage.get(`${row.package.objectPrefix}/book.normalized.html`),
    options.storage.get(`${row.package.objectPrefix}/reading_manifest.json`),
    options.db
      .select({ objectKey: bookProfiles.objectKey })
      .from(bookProfiles)
      .where(eq(bookProfiles.packageId, row.package.id))
      .limit(1)
      .then((items) => items[0]),
  ]);
  if (!bookProfileRow) throw new Error('共享书籍画像不存在');
  const bookProfileBytes = await options.storage.get(bookProfileRow.objectKey);
  return {
    ...row,
    readerProfile,
    rawHtml: new TextDecoder().decode(htmlBytes),
    manifest: readPublishedReadingManifestJson(new TextDecoder().decode(manifestBytes)),
    bookProfile: JSON.parse(new TextDecoder().decode(bookProfileBytes)) as JsonValue,
  };
}
