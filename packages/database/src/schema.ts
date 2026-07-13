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
  NormalizationAttemptStatus,
  NormalizationRunStatus,
  NormalizationValidationOutcome,
  NormalizationValidationPhase,
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
      sql`${table.status} in ('queued', 'normalizing', 'validating', 'indexing', 'analyzing', 'ready', 'failed')`,
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
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
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

export const normalizationAttempts = pgTable(
  'normalization_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    normalizationRunId: uuid('normalization_run_id')
      .notNull()
      .references(() => normalizationRuns.id),
    attemptNo: integer('attempt_no').notNull(),
    status: text('status').$type<NormalizationAttemptStatus>().notNull(),
    sandboxProvider: text('sandbox_provider').notNull(),
    sandboxId: text('sandbox_id'),
    agentSessionId: text('agent_session_id').notNull(),
    agentModel: text('agent_model').notNull(),
    sourceEpubSha256: text('source_epub_sha256').notNull(),
    turnCount: integer('turn_count').notNull().default(0),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    scriptSha256: text('script_sha256'),
    outputInventorySha256: text('output_inventory_sha256'),
    validatorVersion: text('validator_version'),
    validationReportSha256: text('validation_report_sha256'),
    hostOutputInventorySha256: text('host_output_inventory_sha256'),
    hostValidatorVersion: text('host_validator_version'),
    hostValidationReportSha256: text('host_validation_report_sha256'),
    blockingErrorCount: integer('blocking_error_count'),
    warningCount: integer('warning_count'),
    errorClass: text('error_class'),
    errorSummary: text('error_summary'),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull().defaultNow(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('normalization_attempts_run_number_unique').on(
      table.normalizationRunId,
      table.attemptNo,
    ),
    uniqueIndex('normalization_attempts_one_running_per_run')
      .on(table.normalizationRunId)
      .where(sql`${table.status} = 'running'`),
    check('normalization_attempts_number_positive', sql`${table.attemptNo} > 0`),
    check(
      'normalization_attempts_status_valid',
      sql`${table.status} in ('running', 'succeeded', 'failed', 'abandoned')`,
    ),
    check(
      'normalization_attempts_completion_valid',
      sql`((${table.status} = 'running' and ${table.completedAt} is null) or (${table.status} in ('succeeded', 'failed', 'abandoned') and ${table.completedAt} is not null))`,
    ),
    check(
      'normalization_attempts_finish_binding_complete',
      sql`(${table.scriptSha256} is null and ${table.outputInventorySha256} is null and ${table.validatorVersion} is null and ${table.validationReportSha256} is null) or (${table.scriptSha256} is not null and ${table.outputInventorySha256} is not null and ${table.validatorVersion} is not null and ${table.validationReportSha256} is not null)`,
    ),
    check(
      'normalization_attempts_host_binding_complete',
      sql`(${table.hostOutputInventorySha256} is null and ${table.hostValidatorVersion} is null and ${table.hostValidationReportSha256} is null) or (${table.hostOutputInventorySha256} is not null and ${table.hostValidatorVersion} is not null and ${table.hostValidationReportSha256} is not null)`,
    ),
    check(
      'normalization_attempts_succeeded_gate_valid',
      sql`${table.status} <> 'succeeded' or (${table.hostOutputInventorySha256} is not null and ${table.hostValidatorVersion} is not null and ${table.hostValidationReportSha256} is not null and ${table.blockingErrorCount} = 0)`,
    ),
    check(
      'normalization_attempts_hashes_valid',
      sql`${table.sourceEpubSha256} ~ '^[0-9a-f]{64}$' and (${table.scriptSha256} is null or ${table.scriptSha256} ~ '^[0-9a-f]{64}$') and (${table.outputInventorySha256} is null or ${table.outputInventorySha256} ~ '^[0-9a-f]{64}$') and (${table.validationReportSha256} is null or ${table.validationReportSha256} ~ '^[0-9a-f]{64}$') and (${table.hostOutputInventorySha256} is null or ${table.hostOutputInventorySha256} ~ '^[0-9a-f]{64}$') and (${table.hostValidationReportSha256} is null or ${table.hostValidationReportSha256} ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

export const normalizationArtifacts = pgTable(
  'normalization_artifacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    normalizationAttemptId: uuid('normalization_attempt_id')
      .notNull()
      .references(() => normalizationAttempts.id),
    kind: text('kind').notNull(),
    revision: integer('revision').notNull(),
    objectKey: text('object_key').notNull(),
    sha256: text('sha256').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('normalization_artifacts_attempt_kind_revision_unique').on(
      table.normalizationAttemptId,
      table.kind,
      table.revision,
    ),
    uniqueIndex('normalization_artifacts_object_key_unique').on(table.objectKey),
    check('normalization_artifacts_revision_positive', sql`${table.revision} > 0`),
    check('normalization_artifacts_byte_size_nonnegative', sql`${table.byteSize} >= 0`),
    check('normalization_artifacts_sha256_valid', sql`${table.sha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const normalizationValidations = pgTable(
  'normalization_validations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    normalizationAttemptId: uuid('normalization_attempt_id')
      .notNull()
      .references(() => normalizationAttempts.id),
    phase: text('phase').$type<NormalizationValidationPhase>().notNull(),
    invocationNo: integer('invocation_no').notNull(),
    validatorVersion: text('validator_version').notNull(),
    scriptSha256: text('script_sha256').notNull(),
    outputInventorySha256: text('output_inventory_sha256').notNull(),
    reportSha256: text('report_sha256').notNull(),
    sourceEpubSha256: text('source_epub_sha256').notNull(),
    reportObjectKey: text('report_object_key').notNull(),
    exitCode: integer('exit_code').notNull(),
    outcome: text('outcome').$type<NormalizationValidationOutcome>().notNull(),
    blockingErrorCount: integer('blocking_error_count').notNull(),
    warningCount: integer('warning_count').notNull(),
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('normalization_validations_attempt_phase_invocation_unique').on(
      table.normalizationAttemptId,
      table.phase,
      table.invocationNo,
    ),
    check(
      'normalization_validations_phase_valid',
      sql`${table.phase} in ('agent', 'worker_final', 'package')`,
    ),
    check(
      'normalization_validations_outcome_valid',
      sql`${table.outcome} in ('passed', 'passed_with_warnings', 'failed')`,
    ),
    check('normalization_validations_invocation_positive', sql`${table.invocationNo} > 0`),
    check('normalization_validations_errors_nonnegative', sql`${table.blockingErrorCount} >= 0`),
    check('normalization_validations_warnings_nonnegative', sql`${table.warningCount} >= 0`),
    check('normalization_validations_script_sha_valid', sql`${table.scriptSha256} ~ '^[0-9a-f]{64}$'`),
    check('normalization_validations_output_sha_valid', sql`${table.outputInventorySha256} ~ '^[0-9a-f]{64}$'`),
    check('normalization_validations_report_sha_valid', sql`${table.reportSha256} ~ '^[0-9a-f]{64}$'`),
    check('normalization_validations_source_sha_valid', sql`${table.sourceEpubSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const bookPackages = pgTable(
  'book_packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sharedBookId: uuid('shared_book_id')
      .notNull()
      .references(() => sharedBooks.id),
    producerAttemptId: uuid('producer_attempt_id').references(() => normalizationAttempts.id),
    version: text('version').notNull(),
    contractVersion: text('contract_version').notNull(),
    manifestVersion: text('manifest_version').notNull(),
    objectPrefix: text('object_prefix').notNull(),
    fileHashes: jsonb('file_hashes').$type<Record<string, string>>().notNull(),
    validationSummary: jsonb('validation_summary').$type<Record<string, unknown>>().notNull(),
    packageManifestObjectKey: text('package_manifest_object_key'),
    packageManifestSha256: text('package_manifest_sha256'),
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
