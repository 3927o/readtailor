import {
  bigint,
  check,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type {
  NormalizationRunStatus,
  SharedBookStatus,
  SourceUploadStatus,
  SystemJobStatus,
} from '@readtailor/contracts';
import { sql } from 'drizzle-orm';

export const systemJobs = pgTable('system_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  status: text('status').$type<SystemJobStatus>().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  result: jsonb('result').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const sharedBooks = pgTable(
  'shared_books',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    epubSha256: text('epub_sha256').notNull(),
    status: text('status').$type<SharedBookStatus>().notNull(),
    title: text('title').notNull(),
    authors: jsonb('authors').$type<string[]>().notNull(),
    language: text('language').notNull(),
    coverPath: text('cover_path'),
    identifiers: jsonb('identifiers').$type<Record<string, string>>().notNull(),
    publisher: text('publisher'),
    publishedDate: text('published_date'),
    sourceFilename: text('source_filename').notNull(),
    currentPackageId: uuid('current_package_id').references(
      (): AnyPgColumn => bookPackages.id,
    ),
    errorSummary: text('error_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('shared_books_epub_sha256_unique').on(table.epubSha256),
    check(
      'shared_books_status_valid',
      sql`${table.status} in ('queued', 'normalizing', 'indexing', 'ready', 'failed')`,
    ),
    check(
      'shared_books_ready_has_package',
      sql`${table.status} <> 'ready' or ${table.currentPackageId} is not null`,
    ),
  ],
);

export const sourceUploads = pgTable(
  'source_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sharedBookId: uuid('shared_book_id').references(() => sharedBooks.id),
    sourceObjectKey: text('source_object_key').notNull(),
    sourceFilename: text('source_filename').notNull(),
    mediaType: text('media_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    epubSha256: text('epub_sha256').notNull(),
    status: text('status').$type<SourceUploadStatus>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('source_uploads_object_key_unique').on(table.sourceObjectKey),
    check('source_uploads_status_valid', sql`${table.status} in ('stored', 'failed')`),
  ],
);

export const normalizationRuns = pgTable(
  'normalization_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sharedBookId: uuid('shared_book_id')
      .notNull()
      .references(() => sharedBooks.id),
    sourceUploadId: uuid('source_upload_id')
      .notNull()
      .references(() => sourceUploads.id),
    status: text('status').$type<NormalizationRunStatus>().notNull(),
    step: text('step').notNull(),
    attempt: integer('attempt').notNull().default(1),
    errorSummary: text('error_summary'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('normalization_runs_one_running_per_book')
      .on(table.sharedBookId)
      .where(sql`${table.status} = 'running'`),
    check(
      'normalization_runs_status_valid',
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
    check(
      'normalization_runs_completion_valid',
      sql`((${table.status} = 'running' and ${table.completedAt} is null) or (${table.status} in ('completed', 'failed') and ${table.completedAt} is not null))`,
    ),
  ],
);

export const bookPackages = pgTable(
  'book_packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sharedBookId: uuid('shared_book_id')
      .notNull()
      .references(() => sharedBooks.id),
    version: text('version').notNull(),
    contractVersion: text('contract_version').notNull(),
    manifestVersion: text('manifest_version').notNull(),
    objectPrefix: text('object_prefix').notNull(),
    fileHashes: jsonb('file_hashes').$type<Record<string, string>>().notNull(),
    validationSummary: jsonb('validation_summary').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('book_packages_book_version_unique').on(table.sharedBookId, table.version),
    uniqueIndex('book_packages_object_prefix_unique').on(table.objectPrefix),
  ],
);

export const bookProfiles = pgTable(
  'book_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    packageId: uuid('package_id')
      .notNull()
      .references(() => bookPackages.id),
    objectKey: text('object_key').notNull(),
    sha256: text('sha256').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('book_profiles_package_unique').on(table.packageId)],
);
