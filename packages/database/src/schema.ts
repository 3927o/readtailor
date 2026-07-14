import {
  bigint,
  boolean,
  check,
  index,
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
  BookReaderProfile,
  GenerationResult,
  GenerationScope,
  InterviewSessionStatus,
  NodeGenerationStatus,
  NormalizationAttemptStatus,
  NormalizationFailureType,
  NormalizationRunStatus,
  NormalizationValidationOutcome,
  NormalizationValidationPhase,
  ReaderProfile,
  SharedBookStatus,
  SourceUploadStatus,
  Strategy,
  StrategyDraftStatus,
  SystemJobStatus,
  TrialRevisionStatus,
  TrialSegmentStatus,
  UserBookWorkflowStatus,
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
    failureType: text('failure_type').$type<NormalizationFailureType>(),
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
    check(
      'shared_books_failure_type_valid',
      sql`${table.failureType} is null or ${table.failureType} in ('timeout', 'validation_failed', 'external_error', 'internal_error', 'stale_worker')`,
    ),
  ],
);

export const sourceUploads = pgTable(
  'source_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sharedBookId: uuid('shared_book_id').references(() => sharedBooks.id),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
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
    failureType: text('failure_type').$type<NormalizationFailureType>(),
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
      'normalization_runs_failure_type_valid',
      sql`${table.failureType} is null or ${table.failureType} in ('timeout', 'validation_failed', 'external_error', 'internal_error', 'stale_worker')`,
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

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    avatarUrl: text('avatar_url'),
    readerProfileCompletedAt: timestamp('reader_profile_completed_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('users_display_name_nonempty', sql`length(btrim(${table.displayName})) > 0`),
  ],
);

export const authIdentities = pgTable(
  'auth_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').$type<'google' | 'password' | 'development'>().notNull(),
    providerSubject: text('provider_subject').notNull(),
    email: text('email'),
    emailVerified: boolean('email_verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('auth_identities_provider_subject_unique').on(
      table.provider,
      table.providerSubject,
    ),
    index('auth_identities_user_idx').on(table.userId),
    check(
      'auth_identities_provider_valid',
      sql`${table.provider} in ('google', 'password', 'development')`,
    ),
    check(
      'auth_identities_subject_nonempty',
      sql`length(btrim(${table.providerSubject})) > 0`,
    ),
  ],
);

export const authPasswordCredentials = pgTable(
  'auth_password_credentials',
  {
    identityId: uuid('identity_id')
      .primaryKey()
      .references(() => authIdentities.id, { onDelete: 'cascade' }),
    passwordHash: text('password_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'auth_password_credentials_hash_nonempty',
      sql`length(btrim(${table.passwordHash})) > 0`,
    ),
  ],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('auth_sessions_token_hash_unique').on(table.tokenHash),
    index('auth_sessions_user_idx').on(table.userId),
    index('auth_sessions_active_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.revokedAt} is null`),
    check('auth_sessions_token_hash_nonempty', sql`length(${table.tokenHash}) = 64`),
  ],
);

export const readerProfileOnboardings = pgTable(
  'reader_profile_onboardings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    schemaVersion: text('schema_version').notNull(),
    mappingVersion: text('mapping_version').notNull(),
    knowledgeOptionIds: jsonb('knowledge_option_ids').$type<string[]>().notNull(),
    knowledgeFreeText: text('knowledge_free_text'),
    explanationOptionIds: jsonb('explanation_option_ids').$type<string[]>().notNull(),
    explanationFreeText: text('explanation_free_text'),
    backgroundDepthOptionId: text('background_depth_option_id').notNull(),
    extractionStatus: text('extraction_status')
      .$type<'not_requested' | 'completed' | 'failed'>()
      .notNull()
      .default('not_requested'),
    modelConfigId: text('model_config_id'),
    completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reader_profile_onboardings_user_unique').on(table.userId),
    check(
      'reader_profile_onboardings_extraction_status_valid',
      sql`${table.extractionStatus} in ('not_requested', 'completed', 'failed')`,
    ),
  ],
);

export const readerProfiles = pgTable(
  'reader_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    currentVersionId: uuid('current_version_id').references(
      (): AnyPgColumn => readerProfileVersions.id,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('reader_profiles_user_unique').on(table.userId)],
);

export const readerProfileVersions = pgTable(
  'reader_profile_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    readerProfileId: uuid('reader_profile_id')
      .notNull()
      .references(() => readerProfiles.id),
    version: integer('version').notNull(),
    profile: jsonb('profile').$type<ReaderProfile>().notNull(),
    changeSource: text('change_source')
      .$type<'onboarding' | 'interview' | 'question_answer' | 'manual'>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reader_profile_versions_profile_version_unique').on(
      table.readerProfileId,
      table.version,
    ),
    check('reader_profile_versions_version_positive', sql`${table.version} > 0`),
    check(
      'reader_profile_versions_change_source_valid',
      sql`${table.changeSource} in ('onboarding', 'interview', 'question_answer', 'manual')`,
    ),
  ],
);

export const userBooks = pgTable(
  'user_books',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    sharedBookId: uuid('shared_book_id')
      .notNull()
      .references(() => sharedBooks.id),
    workflowStatus: text('workflow_status')
      .$type<UserBookWorkflowStatus>()
      .notNull()
      .default('on_shelf'),
    adjustmentCount: integer('adjustment_count').notNull().default(0),
    currentInterviewSessionId: uuid('current_interview_session_id').references(
      (): AnyPgColumn => interviewSessions.id,
    ),
    currentBookReaderProfileVersionId: uuid(
      'current_book_reader_profile_version_id',
    ).references((): AnyPgColumn => bookReaderProfileVersions.id),
    currentStrategyDraftVersionId: uuid('current_strategy_draft_version_id').references(
      (): AnyPgColumn => strategyDraftVersions.id,
    ),
    currentStrategyVersionId: uuid('current_strategy_version_id').references(
      (): AnyPgColumn => strategyVersions.id,
    ),
    currentTrialRevisionId: uuid('current_trial_revision_id').references(
      (): AnyPgColumn => trialRevisions.id,
    ),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    purgeAfter: timestamp('purge_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('user_books_user_shared_book_unique').on(table.userId, table.sharedBookId),
    check(
      'user_books_workflow_status_valid',
      sql`${table.workflowStatus} in ('on_shelf', 'interviewing', 'strategy_review', 'trial_generating', 'trial_generation_failed', 'trial_review', 'active_reading')`,
    ),
    check(
      'user_books_adjustment_count_valid',
      sql`${table.adjustmentCount} between 0 and 5`,
    ),
    check(
      'user_books_delete_window_complete',
      sql`(${table.deletedAt} is null and ${table.purgeAfter} is null) or (${table.deletedAt} is not null and ${table.purgeAfter} is not null and ${table.purgeAfter} > ${table.deletedAt})`,
    ),
    check(
      'user_books_interview_pointer_present',
      sql`${table.workflowStatus} <> 'interviewing' or ${table.currentInterviewSessionId} is not null`,
    ),
    check(
      'user_books_strategy_pointer_present',
      sql`${table.workflowStatus} <> 'strategy_review' or ${table.currentStrategyDraftVersionId} is not null`,
    ),
    check(
      'user_books_trial_pointers_present',
      sql`${table.workflowStatus} not in ('trial_generating', 'trial_generation_failed', 'trial_review') or (${table.currentStrategyDraftVersionId} is not null and ${table.currentTrialRevisionId} is not null)`,
    ),
    check(
      'user_books_formal_strategy_pointer_present',
      sql`${table.workflowStatus} <> 'active_reading' or ${table.currentStrategyVersionId} is not null`,
    ),
  ],
);

export const interviewSessions = pgTable(
  'interview_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userBookId: uuid('user_book_id')
      .notNull()
      .references(() => userBooks.id),
    status: text('status').$type<InterviewSessionStatus>().notNull().default('active'),
    questionCount: integer('question_count').notNull().default(0),
    conversationVersion: integer('conversation_version').notNull().default(0),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('interview_sessions_user_book_unique').on(table.userBookId),
    check(
      'interview_sessions_status_valid',
      sql`${table.status} in ('active', 'completed', 'cancelled')`,
    ),
    check(
      'interview_sessions_question_count_valid',
      sql`${table.questionCount} between 0 and 7`,
    ),
    check(
      'interview_sessions_conversation_version_nonnegative',
      sql`${table.conversationVersion} >= 0`,
    ),
    check(
      'interview_sessions_completion_valid',
      sql`(${table.status} = 'completed' and ${table.completedAt} is not null) or (${table.status} <> 'completed' and ${table.completedAt} is null)`,
    ),
  ],
);

export const interviewMessages = pgTable(
  'interview_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    interviewSessionId: uuid('interview_session_id')
      .notNull()
      .references(() => interviewSessions.id),
    sequence: integer('sequence').notNull(),
    role: text('role').$type<'user' | 'assistant'>().notNull(),
    kind: text('kind').$type<'question' | 'answer' | 'feedback' | 'summary'>().notNull(),
    content: text('content').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    // Only `feedback` messages carry one (strategy/trial revision requests). A real unique
    // index on it (below) replaces the previous jsonb payload full-scan idempotency check
    // (§6.5), matching the interview_answers idempotency_key column pattern.
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('interview_messages_session_sequence_unique').on(
      table.interviewSessionId,
      table.sequence,
    ),
    uniqueIndex('interview_messages_feedback_idempotency_unique')
      .on(table.interviewSessionId, table.idempotencyKey)
      .where(sql`${table.kind} = 'feedback'`),
    check('interview_messages_sequence_positive', sql`${table.sequence} > 0`),
    check('interview_messages_role_valid', sql`${table.role} in ('user', 'assistant')`),
    check(
      'interview_messages_kind_valid',
      sql`${table.kind} in ('question', 'answer', 'feedback', 'summary')`,
    ),
    check('interview_messages_content_nonempty', sql`length(btrim(${table.content})) > 0`),
    check(
      'interview_messages_idempotency_nonempty',
      sql`${table.idempotencyKey} is null or length(btrim(${table.idempotencyKey})) > 0`,
    ),
  ],
);

export const interviewAnswers = pgTable(
  'interview_answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    interviewSessionId: uuid('interview_session_id')
      .notNull()
      .references(() => interviewSessions.id),
    questionMessageId: uuid('question_message_id')
      .notNull()
      .references(() => interviewMessages.id),
    selectedOptionIds: jsonb('selected_option_ids').$type<string[]>().notNull().default([]),
    freeText: text('free_text'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('interview_answers_session_question_unique').on(
      table.interviewSessionId,
      table.questionMessageId,
    ),
    uniqueIndex('interview_answers_session_idempotency_unique').on(
      table.interviewSessionId,
      table.idempotencyKey,
    ),
    check(
      'interview_answers_has_content',
      sql`jsonb_array_length(${table.selectedOptionIds}) > 0 or length(btrim(coalesce(${table.freeText}, ''))) > 0`,
    ),
    check('interview_answers_idempotency_nonempty', sql`length(btrim(${table.idempotencyKey})) > 0`),
  ],
);

export const bookReaderProfileVersions = pgTable(
  'book_reader_profile_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userBookId: uuid('user_book_id')
      .notNull()
      .references(() => userBooks.id),
    interviewSessionId: uuid('interview_session_id')
      .notNull()
      .references(() => interviewSessions.id),
    version: integer('version').notNull(),
    profile: jsonb('profile').$type<BookReaderProfile>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('book_reader_profile_versions_book_version_unique').on(
      table.userBookId,
      table.version,
    ),
    check('book_reader_profile_versions_version_positive', sql`${table.version} > 0`),
  ],
);

export const strategyDraftVersions = pgTable(
  'strategy_draft_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userBookId: uuid('user_book_id')
      .notNull()
      .references(() => userBooks.id),
    bookReaderProfileVersionId: uuid('book_reader_profile_version_id')
      .notNull()
      .references(() => bookReaderProfileVersions.id),
    sourceMessageId: uuid('source_message_id').references(() => interviewMessages.id),
    version: integer('version').notNull(),
    status: text('status').$type<StrategyDraftStatus>().notNull().default('draft'),
    readingBriefing: text('reading_briefing').notNull(),
    userFacingSummary: text('user_facing_summary').notNull(),
    strategy: jsonb('strategy').$type<Strategy>().notNull(),
    approvedForTrialAt: timestamp('approved_for_trial_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('strategy_draft_versions_book_version_unique').on(
      table.userBookId,
      table.version,
    ),
    uniqueIndex('strategy_draft_versions_one_approved_per_book')
      .on(table.userBookId)
      .where(sql`${table.status} = 'approved_for_trial'`),
    check('strategy_draft_versions_version_positive', sql`${table.version} > 0`),
    check(
      'strategy_draft_versions_status_valid',
      sql`${table.status} in ('draft', 'approved_for_trial', 'confirmed', 'superseded')`,
    ),
    check(
      'strategy_draft_versions_approval_valid',
      sql`${table.status} not in ('approved_for_trial', 'confirmed') or ${table.approvedForTrialAt} is not null`,
    ),
    check(
      'strategy_draft_versions_confirmation_valid',
      sql`${table.status} <> 'confirmed' or ${table.confirmedAt} is not null`,
    ),
    check(
      'strategy_draft_versions_superseded_valid',
      sql`${table.status} <> 'superseded' or ${table.supersededAt} is not null`,
    ),
    check(
      'strategy_draft_versions_content_nonempty',
      sql`length(btrim(${table.readingBriefing})) > 0 and length(btrim(${table.userFacingSummary})) > 0`,
    ),
  ],
);

export const strategyVersions = pgTable(
  'strategy_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userBookId: uuid('user_book_id')
      .notNull()
      .references(() => userBooks.id),
    sourceDraftVersionId: uuid('source_draft_version_id')
      .notNull()
      .references(() => strategyDraftVersions.id),
    version: integer('version').notNull(),
    userFacingSummary: text('user_facing_summary').notNull(),
    strategy: jsonb('strategy').$type<Strategy>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('strategy_versions_book_version_unique').on(table.userBookId, table.version),
    uniqueIndex('strategy_versions_source_draft_unique').on(table.sourceDraftVersionId),
    check('strategy_versions_version_positive', sql`${table.version} > 0`),
    check(
      'strategy_versions_summary_nonempty',
      sql`length(btrim(${table.userFacingSummary})) > 0`,
    ),
  ],
);

export const trialRevisions = pgTable(
  'trial_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userBookId: uuid('user_book_id')
      .notNull()
      .references(() => userBooks.id),
    strategyDraftVersionId: uuid('strategy_draft_version_id')
      .notNull()
      .references(() => strategyDraftVersions.id),
    revision: integer('revision').notNull(),
    status: text('status').$type<TrialRevisionStatus>().notNull().default('draft'),
    failureSummary: text('failure_summary'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    adoptedAt: timestamp('adopted_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('trial_revisions_book_revision_unique').on(table.userBookId, table.revision),
    uniqueIndex('trial_revisions_one_active_per_book')
      .on(table.userBookId)
      .where(
        sql`${table.status} in ('draft', 'generating', 'ready', 'published', 'failed')`,
      ),
    check('trial_revisions_revision_positive', sql`${table.revision} > 0`),
    check(
      'trial_revisions_status_valid',
      sql`${table.status} in ('draft', 'generating', 'ready', 'published', 'adopted', 'failed', 'superseded')`,
    ),
    check(
      'trial_revisions_published_valid',
      sql`${table.status} not in ('published', 'adopted') or ${table.publishedAt} is not null`,
    ),
    check(
      'trial_revisions_adopted_valid',
      sql`${table.status} <> 'adopted' or ${table.adoptedAt} is not null`,
    ),
    check(
      'trial_revisions_failed_valid',
      sql`${table.status} <> 'failed' or (${table.failedAt} is not null and length(btrim(coalesce(${table.failureSummary}, ''))) > 0)`,
    ),
    check(
      'trial_revisions_superseded_valid',
      sql`${table.status} <> 'superseded' or ${table.supersededAt} is not null`,
    ),
  ],
);

export const trialSegments = pgTable(
  'trial_segments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    trialRevisionId: uuid('trial_revision_id')
      .notNull()
      .references(() => trialRevisions.id),
    ordinal: integer('ordinal').notNull(),
    sectionId: text('section_id').notNull(),
    segment: integer('segment').notNull(),
    startBlockIndex: integer('start_block_index').notNull(),
    startOffset: integer('start_offset').notNull(),
    endBlockIndex: integer('end_block_index').notNull(),
    endOffset: integer('end_offset').notNull(),
    selectionReason: text('selection_reason').notNull(),
    status: text('status').$type<TrialSegmentStatus>().notNull().default('pending'),
    viewedAt: timestamp('viewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('trial_segments_revision_ordinal_unique').on(
      table.trialRevisionId,
      table.ordinal,
    ),
    check('trial_segments_ordinal_valid', sql`${table.ordinal} between 1 and 3`),
    check('trial_segments_segment_positive', sql`${table.segment} > 0`),
    check(
      'trial_segments_block_indexes_positive',
      sql`${table.startBlockIndex} > 0 and ${table.endBlockIndex} > 0`,
    ),
    check(
      'trial_segments_offsets_nonnegative',
      sql`${table.startOffset} >= 0 and ${table.endOffset} >= 0`,
    ),
    check(
      'trial_segments_range_order_valid',
      sql`${table.startBlockIndex} < ${table.endBlockIndex} or (${table.startBlockIndex} = ${table.endBlockIndex} and ${table.startOffset} < ${table.endOffset})`,
    ),
    check(
      'trial_segments_status_valid',
      sql`${table.status} in ('pending', 'generating', 'ready', 'failed')`,
    ),
    check('trial_segments_section_nonempty', sql`length(btrim(${table.sectionId})) > 0`),
    check(
      'trial_segments_selection_reason_nonempty',
      sql`length(btrim(${table.selectionReason})) > 0`,
    ),
  ],
);

export const nodeGenerations = pgTable(
  'node_generations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userBookId: uuid('user_book_id')
      .notNull()
      .references(() => userBooks.id),
    generationScope: text('generation_scope').$type<GenerationScope>().notNull(),
    trialSegmentId: uuid('trial_segment_id').references(() => trialSegments.id),
    strategyDraftVersionId: uuid('strategy_draft_version_id').references(
      () => strategyDraftVersions.id,
    ),
    strategyVersionId: uuid('strategy_version_id').references(() => strategyVersions.id),
    sectionId: text('section_id').notNull(),
    segment: integer('segment').notNull(),
    status: text('status').$type<NodeGenerationStatus>().notNull().default('queued'),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    result: jsonb('result').$type<GenerationResult>(),
    modelConfigId: text('model_config_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    cacheKey: text('cache_key').notNull(),
    errorSummary: text('error_summary'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('node_generations_cache_key_idx').on(table.cacheKey),
    uniqueIndex('node_generations_trial_segment_unique')
      .on(table.trialSegmentId)
      .where(sql`${table.generationScope} = 'trial'`),
    uniqueIndex('node_generations_formal_node_strategy_unique')
      .on(table.userBookId, table.strategyVersionId, table.sectionId, table.segment)
      .where(sql`${table.generationScope} = 'formal'`),
    check(
      'node_generations_scope_valid',
      sql`${table.generationScope} in ('trial', 'formal')`,
    ),
    check(
      'node_generations_scope_references_valid',
      sql`(${table.generationScope} = 'trial' and ${table.trialSegmentId} is not null and ${table.strategyDraftVersionId} is not null and ${table.strategyVersionId} is null) or (${table.generationScope} = 'formal' and ${table.trialSegmentId} is null and ${table.strategyDraftVersionId} is null and ${table.strategyVersionId} is not null)`,
    ),
    check(
      'node_generations_status_valid',
      sql`${table.status} in ('queued', 'generating', 'ready', 'failed', 'retrying', 'superseded')`,
    ),
    check('node_generations_segment_positive', sql`${table.segment} > 0`),
    check(
      'node_generations_attempts_valid',
      sql`${table.maxAttempts} > 0 and ${table.attemptCount} between 0 and ${table.maxAttempts}`,
    ),
    check(
      'node_generations_result_valid',
      sql`(${table.status} = 'ready') = (${table.result} is not null)`,
    ),
    check(
      'node_generations_completion_valid',
      sql`(${table.status} in ('ready', 'failed', 'superseded') and ${table.completedAt} is not null) or (${table.status} in ('queued', 'generating', 'retrying') and ${table.completedAt} is null)`,
    ),
    check('node_generations_section_nonempty', sql`length(btrim(${table.sectionId})) > 0`),
    check(
      'node_generations_config_nonempty',
      sql`length(btrim(${table.modelConfigId})) > 0 and length(btrim(${table.promptVersion})) > 0 and length(btrim(${table.cacheKey})) > 0`,
    ),
  ],
);
