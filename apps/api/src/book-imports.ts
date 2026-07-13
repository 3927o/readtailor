import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { ImportBookResponse, NormalizationJobPayload } from '@readtailor/contracts';
import {
  normalizationRuns,
  sharedBooks,
  sourceUploads,
  type Database,
} from '@readtailor/database';
import type { NormalizationQueue } from '@readtailor/queue';
import type { ObjectStorage } from '@readtailor/storage';

const MAX_EPUB_BYTES = 100 * 1024 * 1024;

export class BookImportError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'BookImportError';
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validateUpload(filename: string, mediaType: string, bytes: Uint8Array): string {
  const safeFilename = basename(filename || 'book.epub');
  if (!safeFilename.toLowerCase().endsWith('.epub')) {
    throw new BookImportError('只支持 EPUB 文件');
  }
  if (bytes.byteLength === 0) throw new BookImportError('EPUB 文件为空');
  if (bytes.byteLength > MAX_EPUB_BYTES) {
    throw new BookImportError('EPUB 文件不能超过 100 MB', 413);
  }
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new BookImportError('文件不是有效的 EPUB 压缩包');
  }
  if (
    mediaType &&
    mediaType !== 'application/epub+zip' &&
    mediaType !== 'application/octet-stream' &&
    mediaType !== 'application/zip' &&
    mediaType !== 'application/x-zip-compressed'
  ) {
    throw new BookImportError('文件类型不是 EPUB');
  }
  return safeFilename;
}

export interface BookImportService {
  importBook(input: {
    filename: string;
    mediaType: string;
    bytes: Uint8Array;
  }): Promise<ImportBookResponse>;
}

export function createBookImportService(options: {
  db: Database;
  storage: ObjectStorage;
  queue: NormalizationQueue;
}): BookImportService {
  return {
    async importBook(input) {
      const filename = validateUpload(input.filename, input.mediaType, input.bytes);
      const epubSha256 = sha256(input.bytes);
      const sourceObjectKey = `uploads/by-sha256/${epubSha256}/source.epub`;
      const put = await options.storage.putIfAbsent(
        sourceObjectKey,
        input.bytes,
        'application/epub+zip',
      );
      if (!put.created && sha256(await options.storage.get(sourceObjectKey)) !== epubSha256) {
        throw new Error('immutable source EPUB object has conflicting content');
      }

      const prepared = await options.db.transaction(async (tx) => {
        const proposedBookId = randomUUID();
        await tx
          .insert(sharedBooks)
          .values({
            id: proposedBookId,
            epubSha256,
            status: 'queued',
            title: filename.replace(/\.epub$/i, ''),
            authors: [],
            language: 'und',
            identifiers: {},
            sourceFilename: filename,
          })
          .onConflictDoNothing({ target: sharedBooks.epubSha256 });
        const [book] = await tx
          .select()
          .from(sharedBooks)
          .where(eq(sharedBooks.epubSha256, epubSha256))
          .limit(1);
        if (!book) throw new Error('failed to create or load the shared book');

        if (book.status === 'ready' && book.currentPackageId) {
          return {
            response: {
              bookId: book.id,
              runId: null,
              reused: true,
              status: book.status,
            } satisfies ImportBookResponse,
            enqueue: null,
          };
        }

        const [activeRun] = await tx
          .select({ id: normalizationRuns.id })
          .from(normalizationRuns)
          .where(
            and(
              eq(normalizationRuns.sharedBookId, book.id),
              eq(normalizationRuns.status, 'running'),
            ),
          )
          .limit(1);
        if (activeRun) {
          return {
            response: {
              bookId: book.id,
              runId: activeRun.id,
              reused: false,
              status: book.status,
            } satisfies ImportBookResponse,
            enqueue: null,
          };
        }

        await tx
          .insert(sourceUploads)
          .values({
            id: randomUUID(),
            sharedBookId: book.id,
            sourceObjectKey,
            sourceFilename: filename,
            mediaType: 'application/epub+zip',
            byteSize: input.bytes.byteLength,
            epubSha256,
            status: 'stored',
          })
          .onConflictDoNothing({ target: sourceUploads.sourceObjectKey });
        const [upload] = await tx
          .select({ id: sourceUploads.id, sharedBookId: sourceUploads.sharedBookId })
          .from(sourceUploads)
          .where(eq(sourceUploads.sourceObjectKey, sourceObjectKey))
          .limit(1);
        if (!upload || upload.sharedBookId !== book.id) {
          throw new Error('source upload does not belong to the shared book');
        }

        const [previousRun] = await tx
          .select({ attempt: normalizationRuns.attempt })
          .from(normalizationRuns)
          .where(eq(normalizationRuns.sharedBookId, book.id))
          .orderBy(desc(normalizationRuns.attempt))
          .limit(1);
        const runId = randomUUID();
        await tx.insert(normalizationRuns).values({
          id: runId,
          sharedBookId: book.id,
          sourceUploadId: upload.id,
          status: 'running',
          step: 'queued',
          attempt: (previousRun?.attempt ?? 0) + 1,
        });
        await tx
          .update(sharedBooks)
          .set({
            status: 'queued',
            errorSummary: null,
            sourceFilename: filename,
            updatedAt: sql`now()`,
          })
          .where(eq(sharedBooks.id, book.id));

        const payload: NormalizationJobPayload = {
          kind: 'book.normalize',
          runId,
          requestedAt: new Date().toISOString(),
        };
        return {
          response: {
            bookId: book.id,
            runId,
            reused: false,
            status: 'queued',
          } satisfies ImportBookResponse,
          enqueue: payload,
        };
      });

      if (!prepared.enqueue) return prepared.response;
      try {
        await options.queue.add('book.normalize', prepared.enqueue, {
          jobId: prepared.enqueue.runId,
        });
      } catch (error) {
        const summary = error instanceof Error ? error.message : String(error);
        await options.db.transaction(async (tx) => {
          await tx
            .update(normalizationRuns)
            .set({
              status: 'failed',
              errorSummary: `failed to enqueue normalization: ${summary}`.slice(0, 2000),
              completedAt: sql`now()`,
            })
            .where(eq(normalizationRuns.id, prepared.enqueue!.runId));
          await tx
            .update(sharedBooks)
            .set({ status: 'failed', errorSummary: '规范化任务暂时无法启动', updatedAt: sql`now()` })
            .where(eq(sharedBooks.id, prepared.response.bookId));
        });
        throw error;
      }
      return prepared.response;
    },
  };
}
