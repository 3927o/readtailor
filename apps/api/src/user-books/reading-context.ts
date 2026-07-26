/** Loads shared reading resources used by Reader, Ask AI, and formal generation. */

import { eq } from 'drizzle-orm';
import {
  readerProfiles,
  readerProfileVersions,
  type Database,
} from '@readtailor/database';
import type { BookService } from '../books';
import { UserBookError } from './errors';

export function createReadingContextStore(options: {
  db: Database;
  books: BookService;
  userId: string;
}) {
  const getReaderProfile = async () => {
    const [row] = await options.db
      .select({ version: readerProfileVersions })
      .from(readerProfiles)
      .innerJoin(readerProfileVersions, eq(readerProfileVersions.id, readerProfiles.currentVersionId))
      .where(eq(readerProfiles.userId, options.userId))
      .limit(1);
    if (!row) throw new UserBookError('长期画像不存在', 409);
    return row.version;
  };

  const getManifestAndHtml = async (sharedBookId: string) => {
    const [manifest, content] = await Promise.all([
      options.books.getManifest(sharedBookId),
      options.books.getContent(sharedBookId),
    ]);
    if (!manifest || !content) {
      throw new UserBookError('书籍原文或阅读索引不存在', 409);
    }
    return {
      manifest,
      html: new TextDecoder().decode(content),
    };
  };

  return { getReaderProfile, getManifestAndHtml };
}
