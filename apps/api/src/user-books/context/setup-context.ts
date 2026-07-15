import { asc, eq } from 'drizzle-orm';
import {
  interviewMessages,
  readerProfiles,
  readerProfileVersions,
  sharedBooks,
  userBooks,
  type Database,
} from '@readtailor/database';
import type { BookService } from '../../books';
import { UserBookError } from '../errors';

export type OwnedUserBook = {
  userBook: typeof userBooks.$inferSelect;
  sharedBook: typeof sharedBooks.$inferSelect;
};

export type SetupContextStoreOptions = {
  db: Database;
  books: BookService;
  userId: string;
  getOwnedBook(userBookId: string): Promise<OwnedUserBook>;
};

export function createSetupContextStore(options: SetupContextStoreOptions) {
  const { db, books, userId, getOwnedBook } = options;

  const getReaderProfile = async () => {
    const [row] = await db
      .select({ version: readerProfileVersions })
      .from(readerProfiles)
      .innerJoin(readerProfileVersions, eq(readerProfileVersions.id, readerProfiles.currentVersionId))
      .where(eq(readerProfiles.userId, userId))
      .limit(1);
    if (!row) throw new UserBookError('长期画像不存在', 409);
    return row.version;
  };

  const getSetupContext = async (userBookId: string) => {
    const owned = await getOwnedBook(userBookId);
    const [readerProfile, bookProfile, messages] = await Promise.all([
      getReaderProfile(),
      books.getProfile(owned.sharedBook.id),
      owned.userBook.currentInterviewSessionId
        ? db
            .select()
            .from(interviewMessages)
            .where(eq(interviewMessages.interviewSessionId, owned.userBook.currentInterviewSessionId))
            .orderBy(asc(interviewMessages.sequence))
        : Promise.resolve([]),
    ]);
    if (!bookProfile) throw new UserBookError('共享书籍画像不存在', 409);
    return {
      owned,
      readerProfile,
      context: {
        book: {
          id: owned.sharedBook.id,
          title: owned.sharedBook.title,
          authors: owned.sharedBook.authors,
          language: owned.sharedBook.language,
        },
        bookProfile,
        readerProfile: readerProfile.profile,
        messages: messages.map((message) => ({
          role: message.role,
          kind: message.kind,
          content: message.content,
          payload: message.payload,
        })),
      },
    };
  };

  return { getReaderProfile, getSetupContext };
}
