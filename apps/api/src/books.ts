import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type {
  BookCatalogItem,
  BookNormalizationStatus,
  SharedBook,
} from '@readtailor/contracts';
import {
  bookPackages,
  bookProfiles,
  normalizationAttempts,
  normalizationRuns,
  sharedBooks,
  userBooks,
  type Database,
} from '@readtailor/database';
import {
  ObjectNotFoundError,
  type ObjectStorage,
} from '@readtailor/storage';

export type ReadyBookRecord = SharedBook & {
  objectPrefix: string;
  fileHashes: Record<string, string>;
  profileObjectKey: string;
  profileSha256: string;
};

export interface BookRepository {
  getReadyBook(id: string): Promise<ReadyBookRecord | null>;
  listBooks(userId: string): Promise<BookCatalogItem[]>;
  isOwnedBy(userId: string, id: string): Promise<boolean>;
  getNormalizationStatus(id: string): Promise<BookNormalizationStatus | null>;
}

export interface BookService {
  listBooks(userId: string): Promise<BookCatalogItem[]>;
  canAccess(userId: string, id: string): Promise<boolean>;
  getNormalizationStatus(id: string): Promise<BookNormalizationStatus | null>;
  getBook(id: string): Promise<SharedBook | null>;
  getManifest(id: string): Promise<unknown | null>;
  getProfile(id: string): Promise<unknown | null>;
  getContent(id: string): Promise<Uint8Array | null>;
  getAsset(id: string, assetPath: string): Promise<Uint8Array | null>;
}

export function createDatabaseBookRepository(db: Database): BookRepository {
  const catalogItem = (row: typeof sharedBooks.$inferSelect): BookCatalogItem => ({
    id: row.id,
    epubSha256: row.epubSha256,
    status: row.status,
    title: row.title,
    authors: row.authors,
    coverPath: row.coverPath,
    sourceFilename: row.sourceFilename,
    errorSummary: row.errorSummary,
    failureType: row.failureType,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

  return {
    async getReadyBook(id) {
      const [row] = await db
        .select({ book: sharedBooks, package: bookPackages, profile: bookProfiles })
        .from(sharedBooks)
        .innerJoin(
          bookPackages,
          and(
            eq(bookPackages.id, sharedBooks.currentPackageId),
            eq(bookPackages.sharedBookId, sharedBooks.id),
          ),
        )
        .innerJoin(bookProfiles, eq(bookProfiles.packageId, bookPackages.id))
        .where(and(eq(sharedBooks.id, id), eq(sharedBooks.status, 'ready')))
        .limit(1);

      if (!row) {
        return null;
      }
      return {
        id: row.book.id,
        epubSha256: row.book.epubSha256,
        status: row.book.status,
        title: row.book.title,
        authors: row.book.authors,
        language: row.book.language,
        coverPath: row.book.coverPath,
        identifiers: row.book.identifiers,
        publisher: row.book.publisher,
        publishedDate: row.book.publishedDate,
        sourceFilename: row.book.sourceFilename,
        package: {
          id: row.package.id,
          version: row.package.version,
          contractVersion: row.package.contractVersion,
          manifestVersion: row.package.manifestVersion,
          createdAt: row.package.createdAt.toISOString(),
        },
        objectPrefix: row.package.objectPrefix,
        fileHashes: row.package.fileHashes,
        profileObjectKey: row.profile.objectKey,
        profileSha256: row.profile.sha256,
      };
    },
    async listBooks(userId) {
      const rows = await db
        .select({ book: sharedBooks })
        .from(userBooks)
        .innerJoin(sharedBooks, eq(sharedBooks.id, userBooks.sharedBookId))
        .where(and(eq(userBooks.userId, userId), isNull(userBooks.deletedAt)))
        .orderBy(desc(sharedBooks.updatedAt));
      return rows.map((row) => catalogItem(row.book));
    },
    async isOwnedBy(userId, id) {
      const [row] = await db
        .select({ id: userBooks.id })
        .from(userBooks)
        .where(and(
          eq(userBooks.userId, userId),
          eq(userBooks.sharedBookId, id),
          isNull(userBooks.deletedAt),
        ))
        .limit(1);
      return Boolean(row);
    },
    async getNormalizationStatus(id) {
      const [book] = await db.select().from(sharedBooks).where(eq(sharedBooks.id, id)).limit(1);
      if (!book) return null;
      const [run] = await db
        .select()
        .from(normalizationRuns)
        .where(eq(normalizationRuns.sharedBookId, id))
        .orderBy(desc(normalizationRuns.startedAt))
        .limit(1);
      if (!run) return { book: catalogItem(book), run: null };
      const [attempt] = await db
        .select()
        .from(normalizationAttempts)
        .where(eq(normalizationAttempts.normalizationRunId, run.id))
        .orderBy(desc(normalizationAttempts.attemptNo))
        .limit(1);
      return {
        book: catalogItem(book),
        run: {
          id: run.id,
          status: run.status,
          step: run.step,
          attempt: run.attempt,
          errorSummary: run.errorSummary,
          startedAt: run.startedAt.toISOString(),
          completedAt: run.completedAt?.toISOString() ?? null,
          latestAttempt: attempt
            ? {
                attemptNo: attempt.attemptNo,
                status: attempt.status,
                turnCount: attempt.turnCount,
                toolCallCount: attempt.toolCallCount,
                blockingErrorCount: attempt.blockingErrorCount,
                warningCount: attempt.warningCount,
                errorSummary: attempt.errorSummary,
                startedAt: attempt.startedAt.toISOString(),
                completedAt: attempt.completedAt?.toISOString() ?? null,
              }
            : null,
        },
      };
    },
  };
}

function safeAssetPath(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  const normalized = decoded.replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    return null;
  }
  return normalized;
}

export function createBookService(options: {
  repository: BookRepository;
  storage: ObjectStorage;
}): BookService {
  const readObject = async (key: string): Promise<Uint8Array | null> => {
    try {
      return await options.storage.get(key);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return null;
      }
      throw error;
    }
  };

  const readArtifact = async (
    book: ReadyBookRecord,
    relativePath: string,
  ): Promise<Uint8Array | null> => {
    const expectedHash = book.fileHashes[relativePath];
    if (!expectedHash) {
      return null;
    }
    const bytes = await readObject(`${book.objectPrefix}/${relativePath}`);
    if (!bytes) {
      return null;
    }
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== expectedHash) {
      throw new Error(`book artifact failed integrity check: ${relativePath}`);
    }
    return bytes;
  };

  const withBook = async <T>(
    id: string,
    read: (book: ReadyBookRecord) => Promise<T | null>,
  ): Promise<T | null> => {
    const book = await options.repository.getReadyBook(id);
    return book ? read(book) : null;
  };

  return {
    listBooks(userId) {
      return options.repository.listBooks(userId);
    },
    canAccess(userId, id) {
      return options.repository.isOwnedBy(userId, id);
    },
    getNormalizationStatus(id) {
      return options.repository.getNormalizationStatus(id);
    },
    async getBook(id) {
      const book = await options.repository.getReadyBook(id);
      if (!book) {
        return null;
      }
      const {
        objectPrefix: _objectPrefix,
        fileHashes: _fileHashes,
        profileObjectKey: _profileObjectKey,
        profileSha256: _profileSha256,
        ...publicBook
      } = book;
      return publicBook;
    },
    async getManifest(id) {
      return withBook(id, async (book) => {
        const bytes = await readArtifact(book, 'reading_manifest.json');
        if (!bytes) {
          return null;
        }
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      });
    },
    async getProfile(id) {
      return withBook(id, async (book) => {
        const prefix = `${book.objectPrefix}/`;
        if (!book.profileObjectKey.startsWith(prefix)) {
          throw new Error('book profile object key escapes the current package');
        }
        const relativePath = book.profileObjectKey.slice(prefix.length);
        if (book.fileHashes[relativePath] !== book.profileSha256) {
          throw new Error('book profile database record does not match the package inventory');
        }
        const bytes = await readArtifact(book, relativePath);
        if (!bytes) {
          return null;
        }
        return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      });
    },
    async getContent(id) {
      return withBook(id, (book) => readArtifact(book, 'book.normalized.html'));
    },
    async getAsset(id, assetPath) {
      const safePath = safeAssetPath(assetPath);
      if (!safePath) {
        return null;
      }
      return withBook(id, (book) => readArtifact(book, `assets/${safePath}`));
    },
  };
}
