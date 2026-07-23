import { type Static, Type } from '@sinclair/typebox';
import {
  BlockPointSchema,
  BlockRangeSchema,
  type BlockPoint,
  type BlockRange,
} from '@readtailor/reader-core';
import {
  BriefingSchema,
  READING_STRATEGY_CORE_FIELDS,
} from './reading-setup';

export {
  BookReaderProfileSchema,
  BriefingSchema,
  ProposedStrategySchema,
  type BookReaderProfile,
  type Briefing,
  type ProposedStrategy,
} from './reading-setup';

export const UuidSchema = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});
export type Uuid = Static<typeof UuidSchema>;

export const IdempotencyKeySchema = Type.String({ minLength: 1, maxLength: 200, pattern: '\\S' });
export type IdempotencyKey = Static<typeof IdempotencyKeySchema>;

export const DependencyStatusSchema = Type.Union([Type.Literal('ok'), Type.Literal('error')]);
export type DependencyStatus = Static<typeof DependencyStatusSchema>;

export const HealthResponseSchema = Type.Object({
  service: Type.String(),
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  version: Type.String(),
  timestamp: Type.String(),
  dependencies: Type.Optional(Type.Record(Type.String(), DependencyStatusSchema)),
});
export type HealthResponse = Static<typeof HealthResponseSchema>;

export const SystemJobPayloadSchema = Type.Object({
  jobId: Type.String(),
  kind: Type.Literal('system.ping'),
  requestedAt: Type.String(),
});
export type SystemJobPayload = Static<typeof SystemJobPayloadSchema>;

export const SystemJobStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('completed'),
  Type.Literal('failed'),
]);
export type SystemJobStatus = Static<typeof SystemJobStatusSchema>;

export const SystemJobSchema = Type.Object({
  id: Type.String(),
  kind: Type.String(),
  status: SystemJobStatusSchema,
  result: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  createdAt: Type.String(),
  completedAt: Type.Union([Type.String(), Type.Null()]),
});
export type SystemJob = Static<typeof SystemJobSchema>;

export const SystemChatRequestSchema = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 4000 }),
});
export type SystemChatRequest = Static<typeof SystemChatRequestSchema>;

export const EnqueueSystemPingResponseSchema = Type.Object({
  jobId: Type.String(),
});
export type EnqueueSystemPingResponse = Static<typeof EnqueueSystemPingResponseSchema>;

export const ErrorResponseSchema = Type.Object({
  error: Type.String(),
});
export type ErrorResponse = Static<typeof ErrorResponseSchema>;

export const AuthUserSchema = Type.Object({
  id: Type.String(),
  displayName: Type.String(),
  avatarUrl: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  readerProfileCompleted: Type.Boolean(),
});
export type AuthUser = Static<typeof AuthUserSchema>;

export const AuthSessionResponseSchema = Type.Object({
  user: Type.Union([AuthUserSchema, Type.Null()]),
});
export type AuthSessionResponse = Static<typeof AuthSessionResponseSchema>;

export const DevelopmentLoginRequestSchema = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
});
export type DevelopmentLoginRequest = Static<typeof DevelopmentLoginRequestSchema>;

export const PasswordRegisterRequestSchema = Type.Object({
  displayName: Type.String({ minLength: 1, maxLength: 100 }),
  email: Type.String({ minLength: 3, maxLength: 254 }),
  password: Type.String({ minLength: 10, maxLength: 128 }),
});
export type PasswordRegisterRequest = Static<typeof PasswordRegisterRequestSchema>;

export const PasswordLoginRequestSchema = Type.Object({
  email: Type.String({ minLength: 3, maxLength: 254 }),
  password: Type.String({ minLength: 1, maxLength: 128 }),
});
export type PasswordLoginRequest = Static<typeof PasswordLoginRequestSchema>;

export const ReaderProfileOnboardingRequestSchema = Type.Object({
  knowledgeOptionIds: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 3,
  }),
  knowledgeFreeText: Type.Optional(Type.String({ maxLength: 500 })),
  explanationOptionIds: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 2,
  }),
  explanationFreeText: Type.Optional(Type.String({ maxLength: 500 })),
  backgroundDepthOptionId: Type.String({ minLength: 1 }),
});
export type ReaderProfileOnboardingRequest = Static<
  typeof ReaderProfileOnboardingRequestSchema
>;

export const SourceUploadStatusSchema = Type.Union([
  Type.Literal('stored'),
  Type.Literal('failed'),
]);
export type SourceUploadStatus = Static<typeof SourceUploadStatusSchema>;

export const SharedBookStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('normalizing'),
  Type.Literal('validating'),
  Type.Literal('indexing'),
  Type.Literal('analyzing'),
  Type.Literal('ready'),
  Type.Literal('failed'),
]);
export type SharedBookStatus = Static<typeof SharedBookStatusSchema>;

export const NormalizationRunStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('failed'),
]);
export type NormalizationRunStatus = Static<typeof NormalizationRunStatusSchema>;

export const NormalizationAttemptStatusSchema = Type.Union([
  Type.Literal('running'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('abandoned'),
]);
export type NormalizationAttemptStatus = Static<typeof NormalizationAttemptStatusSchema>;

// 用户可理解的规范化失败类型；内部原始报错仍单独保存在 errorSummary。
export const NormalizationFailureTypeSchema = Type.Union([
  Type.Literal('timeout'),
  Type.Literal('validation_failed'),
  Type.Literal('external_error'),
  Type.Literal('internal_error'),
  Type.Literal('stale_worker'),
]);
export type NormalizationFailureType = Static<typeof NormalizationFailureTypeSchema>;

export const NormalizationValidationPhaseSchema = Type.Union([
  Type.Literal('agent'),
  Type.Literal('worker_final'),
  Type.Literal('package'),
]);
export type NormalizationValidationPhase = Static<
  typeof NormalizationValidationPhaseSchema
>;

export const NormalizationValidationOutcomeSchema = Type.Union([
  Type.Literal('passed'),
  Type.Literal('passed_with_warnings'),
  Type.Literal('failed'),
]);
export type NormalizationValidationOutcome = Static<
  typeof NormalizationValidationOutcomeSchema
>;

export const BookPackageSummarySchema = Type.Object({
  id: Type.String(),
  version: Type.String(),
  contractVersion: Type.String(),
  manifestVersion: Type.String(),
  createdAt: Type.String(),
});
export type BookPackageSummary = Static<typeof BookPackageSummarySchema>;

export const SharedBookSchema = Type.Object({
  id: Type.String(),
  epubSha256: Type.String(),
  status: SharedBookStatusSchema,
  title: Type.String(),
  authors: Type.Array(Type.String()),
  language: Type.String(),
  coverPath: Type.Union([Type.String(), Type.Null()]),
  identifiers: Type.Record(Type.String(), Type.String()),
  publisher: Type.Union([Type.String(), Type.Null()]),
  publishedDate: Type.Union([Type.String(), Type.Null()]),
  sourceFilename: Type.String(),
  package: Type.Union([BookPackageSummarySchema, Type.Null()]),
});
export type SharedBook = Static<typeof SharedBookSchema>;

export const BookCatalogItemSchema = Type.Object({
  id: Type.String(),
  epubSha256: Type.String(),
  status: SharedBookStatusSchema,
  title: Type.String(),
  authors: Type.Array(Type.String()),
  coverPath: Type.Union([Type.String(), Type.Null()]),
  sourceFilename: Type.String(),
  errorSummary: Type.Union([Type.String(), Type.Null()]),
  failureType: Type.Union([NormalizationFailureTypeSchema, Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type BookCatalogItem = Static<typeof BookCatalogItemSchema>;

export const BookCatalogResponseSchema = Type.Object({
  books: Type.Array(BookCatalogItemSchema),
});
export type BookCatalogResponse = Static<typeof BookCatalogResponseSchema>;

export const NormalizationAttemptSummarySchema = Type.Object({
  attemptNo: Type.Integer({ minimum: 1 }),
  status: NormalizationAttemptStatusSchema,
  turnCount: Type.Integer({ minimum: 0 }),
  toolCallCount: Type.Integer({ minimum: 0 }),
  blockingErrorCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  warningCount: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  errorSummary: Type.Union([Type.String(), Type.Null()]),
  startedAt: Type.String(),
  completedAt: Type.Union([Type.String(), Type.Null()]),
});
export type NormalizationAttemptSummary = Static<typeof NormalizationAttemptSummarySchema>;

export const NormalizationRunSummarySchema = Type.Object({
  id: Type.String(),
  status: NormalizationRunStatusSchema,
  step: Type.String(),
  attempt: Type.Integer({ minimum: 1 }),
  errorSummary: Type.Union([Type.String(), Type.Null()]),
  startedAt: Type.String(),
  completedAt: Type.Union([Type.String(), Type.Null()]),
  latestAttempt: Type.Union([NormalizationAttemptSummarySchema, Type.Null()]),
});
export type NormalizationRunSummary = Static<typeof NormalizationRunSummarySchema>;

export const BookNormalizationStatusSchema = Type.Object({
  book: BookCatalogItemSchema,
  run: Type.Union([NormalizationRunSummarySchema, Type.Null()]),
});
export type BookNormalizationStatus = Static<typeof BookNormalizationStatusSchema>;

export const ImportBookResponseSchema = Type.Object({
  bookId: Type.String(),
  runId: Type.Union([Type.String(), Type.Null()]),
  reused: Type.Boolean(),
  status: SharedBookStatusSchema,
});
export type ImportBookResponse = Static<typeof ImportBookResponseSchema>;

export const NormalizationJobPayloadSchema = Type.Object({
  kind: Type.Literal('book.normalize'),
  runId: Type.String(),
  requestedAt: Type.String(),
});
export type NormalizationJobPayload = Static<typeof NormalizationJobPayloadSchema>;

export const UserBookWorkflowStatusSchema = Type.Union([
  Type.Literal('on_shelf'),
  Type.Literal('interviewing'),
  Type.Literal('strategy_review'),
  Type.Literal('trial_generating'),
  Type.Literal('trial_generation_failed'),
  Type.Literal('trial_review'),
  Type.Literal('active_reading'),
]);
export type UserBookWorkflowStatus = Static<typeof UserBookWorkflowStatusSchema>;

export const ReaderProfileSchema = Type.Object({
  summary: Type.String({ minLength: 1 }),
  knowledge: Type.Array(Type.String({ minLength: 1 })),
  explanationPreferences: Type.Array(Type.String({ minLength: 1 })),
});
export type ReaderProfile = Static<typeof ReaderProfileSchema>;

export const ReaderProfileResponseSchema = Type.Object({
  completed: Type.Boolean(),
  profile: Type.Union([ReaderProfileSchema, Type.Null()]),
});
export type ReaderProfileResponse = Static<typeof ReaderProfileResponseSchema>;

export const ReaderProfileVersionSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  profile: ReaderProfileSchema,
  createdAt: Type.String(),
});
export type ReaderProfileVersion = Static<typeof ReaderProfileVersionSchema>;

export const InterviewSessionStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('completed'),
  Type.Literal('cancelled'),
]);
export type InterviewSessionStatus = Static<typeof InterviewSessionStatusSchema>;

export const InterviewQuestionOptionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
});
export type InterviewQuestionOption = Static<typeof InterviewQuestionOptionSchema>;

export const InterviewQuestionSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  // Ordered for token-level streaming (§3.3): acknowledge → ask → options → self-assessed
  // sufficiency last. `acknowledgment` may be empty on the first question.
  acknowledgment: Type.String({ maxLength: 200 }),
  prompt: Type.String({ minLength: 1 }),
  // One-line "why I'm asking" shown under the prompt. Optional so questions persisted before
  // this field existed still validate.
  hint: Type.Optional(Type.String({ maxLength: 300 })),
  options: Type.Array(InterviewQuestionOptionSchema, { minItems: 2, maxItems: 5 }),
  allowFreeText: Type.Literal(true),
  profileDimension: Type.String({ minLength: 1 }),
  sufficiency: Type.Integer({ minimum: 0, maximum: 100 }),
});
export type InterviewQuestion = Static<typeof InterviewQuestionSchema>;

export const InterviewAnswerSchema = Type.Object({
  id: Type.String(),
  questionId: Type.String({ minLength: 1 }),
  // The question text and the resolved answer (option labels + free text joined), so the
  // client can render real history rows instead of "第 N 问" + raw option ids.
  question: Type.String(),
  selectedOptionIds: Type.Array(Type.String({ minLength: 1 }), { maxItems: 5 }),
  freeText: Type.Union([Type.String({ minLength: 1, maxLength: 4000 }), Type.Null()]),
  answerText: Type.String(),
  createdAt: Type.String(),
});
export type InterviewAnswer = Static<typeof InterviewAnswerSchema>;

export const SubmitInterviewAnswerRequestSchema = Type.Object({
  questionId: Type.String({ minLength: 1 }),
  selectedOptionIds: Type.Array(Type.String({ minLength: 1 }), { maxItems: 5 }),
  freeText: Type.Union([Type.String({ minLength: 1, maxLength: 4000 }), Type.Null()]),
  idempotencyKey: IdempotencyKeySchema,
});
export type SubmitInterviewAnswerRequest = Static<
  typeof SubmitInterviewAnswerRequestSchema
>;

export const InterviewStateResponseSchema = Type.Object({
  sessionId: Type.String(),
  status: InterviewSessionStatusSchema,
  turnInProgress: Type.Boolean(),
  completionStarted: Type.Boolean(),
  questionCount: Type.Integer({ minimum: 0, maximum: 7 }),
  maxQuestions: Type.Literal(7),
  currentQuestion: Type.Union([InterviewQuestionSchema, Type.Null()]),
  // Current question's self-assessed sufficiency, surfaced top-level so the non-streaming
  // fallback (GET /interview) can render the progress bar without a live SSE stream.
  sufficiency: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
  answers: Type.Array(InterviewAnswerSchema),
});
export type InterviewStateResponse = Static<typeof InterviewStateResponseSchema>;

export const TextPositionSchema = BlockPointSchema;
export type TextPosition = BlockPoint;

export const TextRangeSchema = BlockRangeSchema;
export type TextRange = BlockRange;

export const TrialFragmentTagSchema = Type.Union([
  Type.Literal('threshold'),
  Type.Literal('typical'),
  Type.Literal('hardest'),
]);
export type TrialFragmentTag = Static<typeof TrialFragmentTagSchema>;

// `tag` and `range` are absent on the candidate-pool hint the interview agent emits and
// present once select_trial_fragments (§3.5) fixes the concrete fragments post-approval.
export const TrialCandidateSchema = Type.Object({
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
  reason: Type.String({ minLength: 1 }),
  tag: Type.Optional(TrialFragmentTagSchema),
  range: Type.Optional(TextRangeSchema),
});
export type TrialCandidate = Static<typeof TrialCandidateSchema>;

const READING_NODE_PREVIEW_FIELDS = {
  ordinal: Type.Integer({ minimum: 1, maximum: 3 }),
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
  chapterPath: Type.Array(Type.String({ minLength: 1 })),
  reason: Type.String({ minLength: 1 }),
};

export const ReadingNodePreviewSchema = Type.Object(READING_NODE_PREVIEW_FIELDS);
export type ReadingNodePreview = Static<typeof ReadingNodePreviewSchema>;

export const StrategySchema = Type.Object({
  ...READING_STRATEGY_CORE_FIELDS,
  trialCandidates: Type.Array(TrialCandidateSchema, { minItems: 3, maxItems: 3 }),
});
export type Strategy = Static<typeof StrategySchema>;

// 问 AI 会话状态 (§8): a session is one question thread (initial + follow-ups); it stays
// `active` while the user can keep asking, and is `closed` once the thread is abandoned/ended.
export const QaSessionStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('closed'),
]);
export type QaSessionStatus = Static<typeof QaSessionStatusSchema>;

// A propose_strategy_change proposal's lifecycle (§8.2, decision B+b): created `pending`; the
// user's confirm promotes it to `confirmed`; an explicit reject makes it `rejected`; a newer
// proposal in the same book supersedes an older still-pending one (`superseded`).
export const StrategyChangeProposalStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('confirmed'),
  Type.Literal('rejected'),
  Type.Literal('superseded'),
]);
export type StrategyChangeProposalStatus = Static<typeof StrategyChangeProposalStatusSchema>;

// ── 问 AI (§8) wire types ────────────────────────────────────────────────────

// The anchor a 问 AI question is asked against: either a highlighted selection or the whole
// on-screen node. Captured once when the thread starts, persisted on qa_sessions and replayed
// to the agent each turn (get_question_context). `sectionId`/`segment` locate the reader's node.
const QA_CONTEXT_NODE = {
  nodeOrder: Type.Integer({ minimum: 1 }),
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
  manifestVersion: Type.Optional(Type.String({ minLength: 1 })),
};

export const QaQuestionContextSchema = Type.Union([
  Type.Object({
    anchor: Type.Literal('highlight'),
    precision: Type.Literal('exact'),
    ...QA_CONTEXT_NODE,
    range: TextRangeSchema,
    quoteSnapshot: Type.String({ minLength: 1, maxLength: 12000 }),
  }),
  Type.Object({
    anchor: Type.Literal('screen'),
    precision: Type.Literal('approximate'),
    ...QA_CONTEXT_NODE,
    focus: TextPositionSchema,
    range: Type.Optional(TextRangeSchema),
    quoteSnapshot: Type.String({ maxLength: 12000 }),
  }),
]);
export type QaQuestionContext = Static<typeof QaQuestionContextSchema>;

// POST /v1/user-books/:id/qa — start a new question thread (omit `sessionId`; `context`
// required) or ask a follow-up in an existing thread (`sessionId` set; `context` ignored — the
// thread keeps its original anchor). `idempotencyKey` dedupes a retried question in its thread.
export const AskQuestionRequestSchema = Type.Object({
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  question: Type.String({ minLength: 1, maxLength: 4000 }),
  context: Type.Optional(QaQuestionContextSchema),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});
export type AskQuestionRequest = Static<typeof AskQuestionRequestSchema>;

// SSE wire events for the streaming 问 AI endpoint (§8). Each frame is `data: <json>\n\n` with
// the discriminator in `type`, mirroring InterviewStreamEvent (a hand-maintained union, since
// the stream bypasses Fastify serialization). `session` is emitted first so the client learns
// the thread id for follow-ups; tool lifecycle events expose names/status only (never arguments,
// results or reasoning); `answer_delta` streams the answer text; `proposal` fires when
// the agent submits a (pending, read-only) strategy-change proposal; `profile_updated` when it
// patches the long-term profile; `done` ends the turn; `error` reports an in-band failure.
export type QaStreamEvent =
  | { type: 'session'; sessionId: string; conversationVersion: number }
  | { type: 'tool_started'; toolCallId: string; toolName: string }
  | {
      type: 'tool_finished';
      toolCallId: string;
      toolName: string;
      succeeded: boolean;
    }
  | { type: 'answer_delta'; chars: string }
  | {
      type: 'proposal';
      proposalId: string;
      revisionId: string;
      revision: number;
      triggeringMessageId: string;
      publicSummary: string;
      status: StrategyChangeProposalStatus;
    }
  | { type: 'profile_updated' }
  | { type: 'done'; sessionId: string; messageId: string }
  | { type: 'error'; message: string };

export const QaProposalRevisionSummarySchema = Type.Object({
  id: Type.String(),
  proposalId: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  triggeringMessageId: Type.String(),
  strategyDraftVersionId: Type.String(),
  publicSummary: Type.String(),
  changedFields: Type.Array(Type.String()),
  reason: Type.String(),
  evidence: Type.String(),
  status: StrategyChangeProposalStatusSchema,
  createdAt: Type.String(),
});
export type QaProposalRevisionSummary = Static<typeof QaProposalRevisionSummarySchema>;

export const QaMessageSchema = Type.Object({
  id: Type.String(),
  sequence: Type.Integer({ minimum: 1 }),
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
  kind: Type.Union([Type.Literal('question'), Type.Literal('answer')]),
  content: Type.String(),
  createdAt: Type.String(),
  proposalRevision: Type.Union([QaProposalRevisionSummarySchema, Type.Null()]),
});
export type QaMessage = Static<typeof QaMessageSchema>;

// The thread's active proposal, if any — display-only in the read-only loop (no confirm
// endpoint yet). `id` is the persisted strategy_change_proposals row for a future confirm flow.
export const QaProposalSummarySchema = Type.Object({
  id: Type.String(),
  status: StrategyChangeProposalStatusSchema,
  publicSummary: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  currentRevisionId: Type.String(),
  currentStrategyDraftVersionId: Type.String(),
  baseStrategyVersionId: Type.String(),
  resultingStrategyVersionId: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
export type QaProposalSummary = Static<typeof QaProposalSummarySchema>;

// GET /v1/user-books/:id/qa/:sessionId — the persisted transcript of one question thread, for
// reload/history. `proposal` is the thread's latest proposal (null when none was made).
export const QaSessionResponseSchema = Type.Object({
  sessionId: Type.String(),
  status: QaSessionStatusSchema,
  conversationVersion: Type.Integer({ minimum: 0 }),
  questionContext: QaQuestionContextSchema,
  contextPrecision: Type.Union([
    Type.Literal('exact'),
    Type.Literal('approximate'),
    Type.Literal('node'),
  ]),
  messages: Type.Array(QaMessageSchema),
  proposal: Type.Union([QaProposalSummarySchema, Type.Null()]),
});
export type QaSessionResponse = Static<typeof QaSessionResponseSchema>;

export const QaSessionListItemSchema = Type.Object({
  sessionId: Type.String(),
  status: QaSessionStatusSchema,
  question: Type.String(),
  updatedAt: Type.String(),
  messageCount: Type.Integer({ minimum: 0 }),
});
export type QaSessionListItem = Static<typeof QaSessionListItemSchema>;

export const QaSessionListResponseSchema = Type.Object({
  sessions: Type.Array(QaSessionListItemSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
export type QaSessionListResponse = Static<typeof QaSessionListResponseSchema>;

export const ProposalFeedbackRequestSchema = Type.Object({
  revisionId: Type.String({ minLength: 1 }),
  feedback: Type.String({ minLength: 1, maxLength: 4000 }),
  idempotencyKey: IdempotencyKeySchema,
});
export type ProposalFeedbackRequest = Static<typeof ProposalFeedbackRequestSchema>;

export const ProposalDecisionRequestSchema = Type.Object({
  revisionId: Type.String({ minLength: 1 }),
  idempotencyKey: IdempotencyKeySchema,
});
export type ProposalDecisionRequest = Static<typeof ProposalDecisionRequestSchema>;

export const ProposalActionResponseSchema = Type.Object({
  proposalId: Type.String(),
  revisionId: Type.String(),
  status: StrategyChangeProposalStatusSchema,
  resultingStrategyVersionId: Type.Union([Type.String(), Type.Null()]),
});
export type ProposalActionResponse = Static<typeof ProposalActionResponseSchema>;

export const StrategyDraftStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('approved_for_trial'),
  Type.Literal('confirmed'),
  Type.Literal('superseded'),
]);
export type StrategyDraftStatus = Static<typeof StrategyDraftStatusSchema>;

const STRATEGY_DRAFT_FIELDS = {
  id: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  status: StrategyDraftStatusSchema,
  readingBriefing: BriefingSchema,
  userFacingSummary: Type.String({ minLength: 1 }),
  strategy: StrategySchema,
  createdAt: Type.String(),
  approvedForTrialAt: Type.Union([Type.String(), Type.Null()]),
};

export const StrategyDraftSchema = Type.Object(STRATEGY_DRAFT_FIELDS);
export type StrategyDraft = Static<typeof StrategyDraftSchema>;

function readingNodePreviewAtOrdinal<const Ordinal extends 1 | 2 | 3>(ordinal: Ordinal) {
  return Type.Object({
    ...READING_NODE_PREVIEW_FIELDS,
    ordinal: Type.Literal(ordinal),
  });
}

const ORDERED_READING_NODE_PREVIEWS_SCHEMA = Type.Tuple([
  readingNodePreviewAtOrdinal(1),
  readingNodePreviewAtOrdinal(2),
  readingNodePreviewAtOrdinal(3),
]);

export const StrategyReviewResponseSchema = Type.Object({
  userBookId: Type.String(),
  workflowStatus: UserBookWorkflowStatusSchema,
  draft: StrategyDraftSchema,
  trialCandidatePreviews: Type.Unsafe<ReadingNodePreview[]>(ORDERED_READING_NODE_PREVIEWS_SCHEMA),
  adjustmentCount: Type.Integer({ minimum: 0, maximum: 5 }),
  adjustmentLimit: Type.Integer({ minimum: 1 }),
  canAdjust: Type.Boolean(),
});
export type StrategyReviewResponse = Static<typeof StrategyReviewResponseSchema>;

// Exact-version reads intentionally retain the broad historical projection: an old draft can be
// superseded while the book has already moved to a later workflow stage. Current reads and stream
// terminal events use the discriminated schema below instead.
export const StrategyReviewSnapshotSchema = StrategyReviewResponseSchema;
export type StrategyReviewSnapshot = StrategyReviewResponse;

const CURRENT_STRATEGY_REVIEW_FIELDS = {
  userBookId: Type.String(),
  trialCandidatePreviews: ORDERED_READING_NODE_PREVIEWS_SCHEMA,
};

const CURRENT_ADJUSTABLE_REVIEW_FIELDS = {
  adjustmentCount: Type.Integer({ minimum: 0, maximum: 4 }),
  adjustmentLimit: Type.Literal(5),
  canAdjust: Type.Literal(true),
};

const CURRENT_EXHAUSTED_REVIEW_FIELDS = {
  adjustmentCount: Type.Literal(5),
  adjustmentLimit: Type.Literal(5),
  canAdjust: Type.Literal(false),
};

const CURRENT_NON_ADJUSTABLE_REVIEW_FIELDS = {
  adjustmentCount: Type.Integer({ minimum: 0, maximum: 5 }),
  adjustmentLimit: Type.Literal(5),
  canAdjust: Type.Literal(false),
};

const CURRENT_DRAFT_STRATEGY_SCHEMA = Type.Object({
  ...STRATEGY_DRAFT_FIELDS,
  status: Type.Literal('draft'),
  approvedForTrialAt: Type.Null(),
});

const CURRENT_APPROVED_STRATEGY_SCHEMA = Type.Object({
  ...STRATEGY_DRAFT_FIELDS,
  status: Type.Literal('approved_for_trial'),
  approvedForTrialAt: Type.String(),
});

const CURRENT_CONFIRMED_STRATEGY_SCHEMA = Type.Object({
  ...STRATEGY_DRAFT_FIELDS,
  status: Type.Literal('confirmed'),
  approvedForTrialAt: Type.String(),
});

const CURRENT_STRATEGY_REVIEW_RESPONSE_SCHEMA = Type.Union([
  Type.Object({
    ...CURRENT_STRATEGY_REVIEW_FIELDS,
    ...CURRENT_ADJUSTABLE_REVIEW_FIELDS,
    workflowStatus: Type.Literal('strategy_review'),
    draft: CURRENT_DRAFT_STRATEGY_SCHEMA,
  }),
  Type.Object({
    ...CURRENT_STRATEGY_REVIEW_FIELDS,
    ...CURRENT_EXHAUSTED_REVIEW_FIELDS,
    workflowStatus: Type.Literal('strategy_review'),
    draft: CURRENT_DRAFT_STRATEGY_SCHEMA,
  }),
  Type.Object({
    ...CURRENT_STRATEGY_REVIEW_FIELDS,
    ...CURRENT_NON_ADJUSTABLE_REVIEW_FIELDS,
    workflowStatus: Type.Literal('trial_generating'),
    draft: CURRENT_APPROVED_STRATEGY_SCHEMA,
  }),
  Type.Object({
    ...CURRENT_STRATEGY_REVIEW_FIELDS,
    ...CURRENT_NON_ADJUSTABLE_REVIEW_FIELDS,
    workflowStatus: Type.Literal('trial_generation_failed'),
    draft: CURRENT_APPROVED_STRATEGY_SCHEMA,
  }),
  Type.Object({
    ...CURRENT_STRATEGY_REVIEW_FIELDS,
    ...CURRENT_NON_ADJUSTABLE_REVIEW_FIELDS,
    workflowStatus: Type.Literal('trial_review'),
    draft: CURRENT_APPROVED_STRATEGY_SCHEMA,
  }),
  Type.Object({
    ...CURRENT_STRATEGY_REVIEW_FIELDS,
    ...CURRENT_NON_ADJUSTABLE_REVIEW_FIELDS,
    workflowStatus: Type.Literal('active_reading'),
    draft: CURRENT_CONFIRMED_STRATEGY_SCHEMA,
  }),
]);
export type CurrentStrategyReviewResponse = Static<
  typeof CURRENT_STRATEGY_REVIEW_RESPONSE_SCHEMA
>;
export const CurrentStrategyReviewResponseSchema = CURRENT_STRATEGY_REVIEW_RESPONSE_SCHEMA;

export const SubmitStrategyFeedbackRequestSchema = Type.Object({
  strategyDraftVersionId: UuidSchema,
  feedback: Type.String({ minLength: 1, maxLength: 4000, pattern: '\\S' }),
  idempotencyKey: IdempotencyKeySchema,
});
export type SubmitStrategyFeedbackRequest = Static<
  typeof SubmitStrategyFeedbackRequestSchema
>;

export const ApproveStrategyRequestSchema = Type.Object({
  strategyDraftVersionId: UuidSchema,
  idempotencyKey: IdempotencyKeySchema,
});
export type ApproveStrategyRequest = Static<typeof ApproveStrategyRequestSchema>;

export const GenerationAnnotationSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  range: TextRangeSchema,
  content: Type.String({ minLength: 1 }),
});
export type GenerationAnnotation = Static<typeof GenerationAnnotationSchema>;

export const GenerationResultSchema = Type.Object({
  guide: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  annotations: Type.Array(GenerationAnnotationSchema),
  afterReading: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
});
export type GenerationResult = Static<typeof GenerationResultSchema>;

export const GenerationScopeSchema = Type.Union([
  Type.Literal('trial'),
  Type.Literal('formal'),
]);
export type GenerationScope = Static<typeof GenerationScopeSchema>;

export const NodeGenerationStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('generating'),
  Type.Literal('ready'),
  Type.Literal('failed'),
  Type.Literal('retrying'),
  Type.Literal('superseded'),
]);
export type NodeGenerationStatus = Static<typeof NodeGenerationStatusSchema>;

export const TrialRevisionStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('generating'),
  Type.Literal('ready'),
  Type.Literal('published'),
  Type.Literal('adopted'),
  Type.Literal('failed'),
  Type.Literal('superseded'),
]);
export type TrialRevisionStatus = Static<typeof TrialRevisionStatusSchema>;

export const TrialSegmentStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('generating'),
  Type.Literal('ready'),
  Type.Literal('failed'),
]);
export type TrialSegmentStatus = Static<typeof TrialSegmentStatusSchema>;

const TRIAL_SEGMENT_FIELDS = {
  id: Type.String(),
  ordinal: Type.Integer({ minimum: 1, maximum: 3 }),
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
  range: TextRangeSchema,
  chapterPath: Type.Array(Type.String({ minLength: 1 })),
  originalHtml: Type.String({ minLength: 1 }),
  selectionReason: Type.String({ minLength: 1 }),
  viewedAt: Type.Union([Type.String(), Type.Null()]),
};

const PENDING_TRIAL_SEGMENT_SCHEMA = Type.Object({
  ...TRIAL_SEGMENT_FIELDS,
  status: Type.Literal('pending'),
  result: Type.Null(),
});
const GENERATING_TRIAL_SEGMENT_SCHEMA = Type.Object({
  ...TRIAL_SEGMENT_FIELDS,
  status: Type.Literal('generating'),
  result: Type.Null(),
});
const READY_TRIAL_SEGMENT_SCHEMA = Type.Object({
  ...TRIAL_SEGMENT_FIELDS,
  status: Type.Literal('ready'),
  result: GenerationResultSchema,
});
const FAILED_TRIAL_SEGMENT_SCHEMA = Type.Object({
  ...TRIAL_SEGMENT_FIELDS,
  status: Type.Literal('failed'),
  result: Type.Null(),
});

export const TrialSegmentSchema = Type.Union([
  PENDING_TRIAL_SEGMENT_SCHEMA,
  GENERATING_TRIAL_SEGMENT_SCHEMA,
  READY_TRIAL_SEGMENT_SCHEMA,
  FAILED_TRIAL_SEGMENT_SCHEMA,
]);
export type TrialSegment = Static<typeof TrialSegmentSchema>;

function trialSegmentAtOrdinal<const Ordinal extends 1 | 2 | 3>(ordinal: Ordinal) {
  const fields = { ...TRIAL_SEGMENT_FIELDS, ordinal: Type.Literal(ordinal) };
  return Type.Union([
    Type.Object({ ...fields, status: Type.Literal('pending'), result: Type.Null() }),
    Type.Object({ ...fields, status: Type.Literal('generating'), result: Type.Null() }),
    Type.Object({ ...fields, status: Type.Literal('ready'), result: GenerationResultSchema }),
    Type.Object({ ...fields, status: Type.Literal('failed'), result: Type.Null() }),
  ], {
    // fast-json-stringify requires tuple items to expose their top-level JSON type.
    type: 'object',
  });
}

function readyTrialSegmentAtOrdinal<const Ordinal extends 1 | 2 | 3>(ordinal: Ordinal) {
  return Type.Object({
    ...TRIAL_SEGMENT_FIELDS,
    ordinal: Type.Literal(ordinal),
    status: Type.Literal('ready'),
    result: GenerationResultSchema,
  });
}

const ORDERED_TRIAL_SEGMENTS_SCHEMA = Type.Tuple([
  trialSegmentAtOrdinal(1),
  trialSegmentAtOrdinal(2),
  trialSegmentAtOrdinal(3),
]);

export const TrialReviewResponseSchema = Type.Object({
  userBookId: Type.String(),
  workflowStatus: UserBookWorkflowStatusSchema,
  trialRevisionId: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  status: TrialRevisionStatusSchema,
  strategyDraftVersionId: Type.String(),
  segments: Type.Unsafe<TrialSegment[]>(ORDERED_TRIAL_SEGMENTS_SCHEMA),
  adjustmentCount: Type.Integer({ minimum: 0, maximum: 5 }),
  adjustmentLimit: Type.Integer({ minimum: 1 }),
  canAdjust: Type.Boolean(),
  canAdopt: Type.Boolean(),
});
export type TrialReviewResponse = Static<typeof TrialReviewResponseSchema>;

export const TrialReviewSnapshotSchema = TrialReviewResponseSchema;
export type TrialReviewSnapshot = TrialReviewResponse;

const ORDERED_READY_TRIAL_SEGMENTS_SCHEMA = Type.Tuple([
  readyTrialSegmentAtOrdinal(1),
  readyTrialSegmentAtOrdinal(2),
  readyTrialSegmentAtOrdinal(3),
]);

const CURRENT_TRIAL_REVIEW_FIELDS = {
  userBookId: Type.String(),
  trialRevisionId: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  strategyDraftVersionId: Type.String(),
};

const CURRENT_TRIAL_REVIEW_RESPONSE_SCHEMA = Type.Union([
  Type.Object({
    ...CURRENT_TRIAL_REVIEW_FIELDS,
    ...CURRENT_NON_ADJUSTABLE_REVIEW_FIELDS,
    workflowStatus: Type.Literal('trial_generating'),
    status: Type.Literal('generating'),
    segments: ORDERED_TRIAL_SEGMENTS_SCHEMA,
    canAdopt: Type.Literal(false),
  }),
  Type.Object({
    ...CURRENT_TRIAL_REVIEW_FIELDS,
    ...CURRENT_NON_ADJUSTABLE_REVIEW_FIELDS,
    workflowStatus: Type.Literal('trial_generation_failed'),
    status: Type.Literal('failed'),
    segments: ORDERED_TRIAL_SEGMENTS_SCHEMA,
    canAdopt: Type.Literal(false),
  }),
  Type.Object({
    ...CURRENT_TRIAL_REVIEW_FIELDS,
    ...CURRENT_ADJUSTABLE_REVIEW_FIELDS,
    workflowStatus: Type.Literal('trial_review'),
    status: Type.Literal('published'),
    segments: ORDERED_READY_TRIAL_SEGMENTS_SCHEMA,
    canAdopt: Type.Literal(true),
  }),
  Type.Object({
    ...CURRENT_TRIAL_REVIEW_FIELDS,
    ...CURRENT_EXHAUSTED_REVIEW_FIELDS,
    workflowStatus: Type.Literal('trial_review'),
    status: Type.Literal('published'),
    segments: ORDERED_READY_TRIAL_SEGMENTS_SCHEMA,
    canAdopt: Type.Literal(true),
  }),
  Type.Object({
    ...CURRENT_TRIAL_REVIEW_FIELDS,
    ...CURRENT_NON_ADJUSTABLE_REVIEW_FIELDS,
    workflowStatus: Type.Literal('active_reading'),
    status: Type.Literal('adopted'),
    segments: ORDERED_READY_TRIAL_SEGMENTS_SCHEMA,
    canAdopt: Type.Literal(false),
  }),
]);
export type CurrentTrialReviewResponse = Static<typeof CURRENT_TRIAL_REVIEW_RESPONSE_SCHEMA>;
export const CurrentTrialReviewResponseSchema = CURRENT_TRIAL_REVIEW_RESPONSE_SCHEMA;

export const ProvisionalTrialSampleSchema = Type.Union([
  Type.Object({
    ordinal: Type.Literal(1),
    tag: Type.Literal('threshold'),
    sectionId: Type.String({ minLength: 1 }),
    segment: Type.Integer({ minimum: 1 }),
    range: TextRangeSchema,
    chapterPath: Type.Array(Type.String({ minLength: 1 })),
    originalHtml: Type.String({ minLength: 1 }),
    selectionReason: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    ordinal: Type.Literal(2),
    tag: Type.Literal('typical'),
    sectionId: Type.String({ minLength: 1 }),
    segment: Type.Integer({ minimum: 1 }),
    range: TextRangeSchema,
    chapterPath: Type.Array(Type.String({ minLength: 1 })),
    originalHtml: Type.String({ minLength: 1 }),
    selectionReason: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    ordinal: Type.Literal(3),
    tag: Type.Literal('hardest'),
    sectionId: Type.String({ minLength: 1 }),
    segment: Type.Integer({ minimum: 1 }),
    range: TextRangeSchema,
    chapterPath: Type.Array(Type.String({ minLength: 1 })),
    originalHtml: Type.String({ minLength: 1 }),
    selectionReason: Type.String({ minLength: 1 }),
  }),
]);
export type ProvisionalTrialSample = Static<typeof ProvisionalTrialSampleSchema>;

export const ReadingSetupOperationKindSchema = Type.Union([
  Type.Literal('strategy_revision'),
  Type.Literal('trial_selection'),
]);
export type ReadingSetupOperationKind = Static<typeof ReadingSetupOperationKindSchema>;

export const ReadingSetupOperationSourceSchema = Type.Union([
  Type.Literal('strategy_feedback'),
  Type.Literal('trial_feedback'),
  Type.Literal('strategy_approve'),
]);
export type ReadingSetupOperationSource = Static<typeof ReadingSetupOperationSourceSchema>;

export const ReadingSetupOperationStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('failed'),
]);
export type ReadingSetupOperationStatus = Static<typeof ReadingSetupOperationStatusSchema>;

export const ReadingSetupOperationPayloadSchema = Type.Union([
  Type.Object({
    source: Type.Literal('strategy_feedback'),
    strategyDraftVersionId: UuidSchema,
    feedback: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
  Type.Object({
    source: Type.Literal('trial_feedback'),
    strategyDraftVersionId: UuidSchema,
    trialRevisionId: UuidSchema,
    feedback: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
  Type.Object({
    source: Type.Literal('strategy_approve'),
    strategyDraftVersionId: UuidSchema,
  }),
]);
export type ReadingSetupOperationPayload = Static<typeof ReadingSetupOperationPayloadSchema>;

export const ReadingSetupRecoverableInputSchema = Type.Object({
  feedback: Type.String({ minLength: 1, maxLength: 4000 }),
});
export type ReadingSetupRecoverableInput = Static<typeof ReadingSetupRecoverableInputSchema>;

const READING_SETUP_OPERATION_RESPONSE_FIELDS = {
  operationId: UuidSchema,
  operationAttempt: Type.Integer({ minimum: 0 }),
  baseDraftId: UuidSchema,
  canResume: Type.Boolean(),
};

const READING_SETUP_FEEDBACK_OPERATION_OUTCOME = Type.Union([
  Type.Object({
    status: Type.Union([Type.Literal('pending'), Type.Literal('running')]),
    resultDraftId: Type.Null(),
    resultTrialRevisionId: Type.Null(),
    errorSummary: Type.Null(),
    recoverableInput: ReadingSetupRecoverableInputSchema,
  }),
  Type.Object({
    status: Type.Literal('completed'),
    resultDraftId: UuidSchema,
    resultTrialRevisionId: Type.Null(),
    errorSummary: Type.Null(),
    recoverableInput: Type.Null(),
  }),
  Type.Object({
    status: Type.Literal('failed'),
    resultDraftId: Type.Null(),
    resultTrialRevisionId: Type.Null(),
    errorSummary: Type.String({ minLength: 1 }),
    recoverableInput: ReadingSetupRecoverableInputSchema,
  }),
]);

const READING_SETUP_APPROVE_OPERATION_OUTCOME = Type.Union([
  Type.Object({
    status: Type.Union([Type.Literal('pending'), Type.Literal('running')]),
    resultDraftId: Type.Null(),
    resultTrialRevisionId: Type.Null(),
    errorSummary: Type.Null(),
    recoverableInput: Type.Null(),
  }),
  Type.Object({
    status: Type.Literal('completed'),
    resultDraftId: Type.Null(),
    resultTrialRevisionId: UuidSchema,
    errorSummary: Type.Null(),
    recoverableInput: Type.Null(),
  }),
  Type.Object({
    status: Type.Literal('failed'),
    resultDraftId: Type.Null(),
    resultTrialRevisionId: Type.Null(),
    errorSummary: Type.String({ minLength: 1 }),
    recoverableInput: Type.Null(),
  }),
]);

export const ReadingSetupOperationResponseSchema = Type.Union([
  Type.Intersect([
    Type.Object({
      ...READING_SETUP_OPERATION_RESPONSE_FIELDS,
      kind: Type.Literal('strategy_revision'),
      source: Type.Literal('strategy_feedback'),
      baseTrialRevisionId: Type.Null(),
    }),
    READING_SETUP_FEEDBACK_OPERATION_OUTCOME,
  ]),
  Type.Intersect([
    Type.Object({
      ...READING_SETUP_OPERATION_RESPONSE_FIELDS,
      kind: Type.Literal('strategy_revision'),
      source: Type.Literal('trial_feedback'),
      baseTrialRevisionId: UuidSchema,
    }),
    READING_SETUP_FEEDBACK_OPERATION_OUTCOME,
  ]),
  Type.Intersect([
    Type.Object({
      ...READING_SETUP_OPERATION_RESPONSE_FIELDS,
      kind: Type.Literal('trial_selection'),
      source: Type.Literal('strategy_approve'),
      baseTrialRevisionId: Type.Null(),
    }),
    READING_SETUP_APPROVE_OPERATION_OUTCOME,
  ]),
]);
export type ReadingSetupOperationResponse = Static<typeof ReadingSetupOperationResponseSchema>;

export const CurrentReadingSetupOperationResponseSchema = Type.Union([
  ReadingSetupOperationResponseSchema,
  Type.Null(),
]);
export type CurrentReadingSetupOperationResponse = Static<
  typeof CurrentReadingSetupOperationResponseSchema
>;

export const ReadingSetupOperationDetailParamsSchema = Type.Object({
  id: UuidSchema,
  operationId: UuidSchema,
});
export type ReadingSetupOperationDetailParams = Static<
  typeof ReadingSetupOperationDetailParamsSchema
>;

export const StrategyDraftSnapshotParamsSchema = Type.Object({
  id: UuidSchema,
  draftId: UuidSchema,
});
export type StrategyDraftSnapshotParams = Static<typeof StrategyDraftSnapshotParamsSchema>;

export const TrialRevisionSnapshotParamsSchema = Type.Object({
  id: UuidSchema,
  trialRevisionId: UuidSchema,
});
export type TrialRevisionSnapshotParams = Static<typeof TrialRevisionSnapshotParamsSchema>;

export const ReadingSetupStreamErrorCodeSchema = Type.Union([
  Type.Literal('agent_failed'),
  Type.Literal('validation_failed'),
  Type.Literal('lease_lost'),
  Type.Literal('internal_error'),
]);
export type ReadingSetupStreamErrorCode = Static<typeof ReadingSetupStreamErrorCodeSchema>;

export const ReadingBriefingFieldSchema = Type.Union([
  Type.Literal('book_identity'),
  Type.Literal('arc'),
  Type.Literal('assumed_knowledge'),
  Type.Literal('reading_advice'),
]);
export type ReadingBriefingField = Static<typeof ReadingBriefingFieldSchema>;

const INTERVIEW_STREAM_ENVELOPE = {
  userBookId: UuidSchema,
  streamId: UuidSchema,
  sequence: Type.Integer({ minimum: 1 }),
};

const INTERVIEW_SPECULATIVE_STREAM_ENVELOPE = {
  ...INTERVIEW_STREAM_ENVELOPE,
  speculativeEpoch: Type.Integer({ minimum: 1 }),
};

// SSE wire contract shared by answer and resume streams. Every frame is tied to one stream
// and ordered by sequence; provisional tool-call output additionally carries an epoch so a
// restarted tool call cannot append to stale text from an earlier attempt.
export const InterviewStreamEventSchema = Type.Union([
  Type.Object({
    ...INTERVIEW_SPECULATIVE_STREAM_ENVELOPE,
    type: Type.Literal('speculative_reset'),
    phase: Type.Literal('interviewing'),
  }),
  Type.Object({ ...INTERVIEW_SPECULATIVE_STREAM_ENVELOPE, type: Type.Literal('ack_delta'), chars: Type.String({ minLength: 1 }) }),
  Type.Object({ ...INTERVIEW_SPECULATIVE_STREAM_ENVELOPE, type: Type.Literal('prompt_delta'), chars: Type.String({ minLength: 1 }) }),
  Type.Object({ ...INTERVIEW_SPECULATIVE_STREAM_ENVELOPE, type: Type.Literal('hint_delta'), chars: Type.String({ minLength: 1 }) }),
  Type.Object({
    ...INTERVIEW_SPECULATIVE_STREAM_ENVELOPE,
    type: Type.Literal('option_added'),
    id: Type.String({ minLength: 1 }),
    label: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    ...INTERVIEW_SPECULATIVE_STREAM_ENVELOPE,
    type: Type.Literal('sufficiency'),
    value: Type.Integer({ minimum: 0, maximum: 100 }),
  }),
  Type.Object({
    ...INTERVIEW_SPECULATIVE_STREAM_ENVELOPE,
    type: Type.Literal('draft_started'),
    conversationVersion: Type.Integer({ minimum: 0 }),
  }),
  Type.Object({
    ...INTERVIEW_SPECULATIVE_STREAM_ENVELOPE,
    type: Type.Literal('briefing_delta'),
    field: ReadingBriefingFieldSchema,
    chars: Type.String({ minLength: 1 }),
  }),
  Type.Object({ ...INTERVIEW_SPECULATIVE_STREAM_ENVELOPE, type: Type.Literal('strategy_delta'), chars: Type.String({ minLength: 1 }) }),
  Type.Object({
    ...INTERVIEW_SPECULATIVE_STREAM_ENVELOPE,
    type: Type.Literal('reading_node_added'),
    node: ReadingNodePreviewSchema,
  }),
  Type.Object({
    ...INTERVIEW_STREAM_ENVELOPE,
    type: Type.Literal('question_final'),
    question: InterviewQuestionSchema,
    ordinal: Type.Integer({ minimum: 1, maximum: 7 }),
    maxQuestions: Type.Literal(7),
  }),
  Type.Object({
    ...INTERVIEW_STREAM_ENVELOPE,
    type: Type.Literal('draft_final'),
    strategy: Type.Unsafe<StrategyReviewResponse>(CurrentStrategyReviewResponseSchema),
  }),
  Type.Object({
    ...INTERVIEW_STREAM_ENVELOPE,
    type: Type.Literal('done'),
    workflowStatus: UserBookWorkflowStatusSchema,
  }),
  Type.Object({
    ...INTERVIEW_STREAM_ENVELOPE,
    type: Type.Literal('error'),
    code: ReadingSetupStreamErrorCodeSchema,
    message: Type.String({ minLength: 1 }),
  }),
]);
export type InterviewStreamEvent = Static<typeof InterviewStreamEventSchema>;

const READING_SETUP_OPERATION_STREAM_ENVELOPE = {
  userBookId: UuidSchema,
  operationId: UuidSchema,
  operationAttempt: Type.Integer({ minimum: 1 }),
  sequence: Type.Integer({ minimum: 1 }),
};

export const StrategyRevisionStreamEventSchema = Type.Union([
  Type.Object({
    ...READING_SETUP_OPERATION_STREAM_ENVELOPE,
    type: Type.Literal('speculative_reset'),
    speculativeEpoch: Type.Integer({ minimum: 1 }),
    phase: Type.Literal('strategy_review'),
  }),
  Type.Object({
    ...READING_SETUP_OPERATION_STREAM_ENVELOPE,
    type: Type.Literal('revision_started'),
    speculativeEpoch: Type.Integer({ minimum: 1 }),
    source: Type.Literal('strategy_feedback'),
    baseDraftId: UuidSchema,
    baseTrialRevisionId: Type.Null(),
  }),
  Type.Object({
    ...READING_SETUP_OPERATION_STREAM_ENVELOPE,
    type: Type.Literal('revision_started'),
    speculativeEpoch: Type.Integer({ minimum: 1 }),
    source: Type.Literal('trial_feedback'),
    baseDraftId: UuidSchema,
    baseTrialRevisionId: UuidSchema,
  }),
  Type.Object({
    ...READING_SETUP_OPERATION_STREAM_ENVELOPE,
    type: Type.Literal('strategy_delta'),
    speculativeEpoch: Type.Integer({ minimum: 1 }),
    chars: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    ...READING_SETUP_OPERATION_STREAM_ENVELOPE,
    type: Type.Literal('reading_node_added'),
    speculativeEpoch: Type.Integer({ minimum: 1 }),
    node: ReadingNodePreviewSchema,
  }),
  Type.Object({
    ...READING_SETUP_OPERATION_STREAM_ENVELOPE,
    type: Type.Literal('revision_final'),
    strategy: Type.Unsafe<StrategyReviewResponse>(CurrentStrategyReviewResponseSchema),
  }),
  Type.Object({
    ...READING_SETUP_OPERATION_STREAM_ENVELOPE,
    type: Type.Literal('error'),
    code: ReadingSetupStreamErrorCodeSchema,
    message: Type.String({ minLength: 1 }),
  }),
]);
export type StrategyRevisionStreamEvent = Static<typeof StrategyRevisionStreamEventSchema>;

export const TrialSelectionSlotSchema = Type.Union([
  Type.Object({ ordinal: Type.Literal(1), tag: Type.Literal('threshold') }),
  Type.Object({ ordinal: Type.Literal(2), tag: Type.Literal('typical') }),
  Type.Object({ ordinal: Type.Literal(3), tag: Type.Literal('hardest') }),
]);
export type TrialSelectionSlot = Static<typeof TrialSelectionSlotSchema>;

export const TrialSelectionStreamEventSchema = Type.Union([
  Type.Object({
    ...READING_SETUP_OPERATION_STREAM_ENVELOPE,
    type: Type.Literal('speculative_reset'),
    speculativeEpoch: Type.Integer({ minimum: 1 }),
    phase: Type.Literal('select_trial'),
  }),
  Type.Object({
    ...READING_SETUP_OPERATION_STREAM_ENVELOPE,
    type: Type.Literal('selection_started'),
    speculativeEpoch: Type.Integer({ minimum: 1 }),
    draftId: UuidSchema,
    slots: Type.Tuple([
      Type.Object({ ordinal: Type.Literal(1), tag: Type.Literal('threshold') }),
      Type.Object({ ordinal: Type.Literal(2), tag: Type.Literal('typical') }),
      Type.Object({ ordinal: Type.Literal(3), tag: Type.Literal('hardest') }),
    ]),
  }),
  Type.Object({
    ...READING_SETUP_OPERATION_STREAM_ENVELOPE,
    type: Type.Literal('fragment_selected'),
    speculativeEpoch: Type.Integer({ minimum: 1 }),
    draftId: UuidSchema,
    sample: ProvisionalTrialSampleSchema,
  }),
  Type.Object({
    ...READING_SETUP_OPERATION_STREAM_ENVELOPE,
    type: Type.Literal('trial_created'),
    draftId: UuidSchema,
    trial: Type.Unsafe<TrialReviewResponse>(CurrentTrialReviewResponseSchema),
  }),
  Type.Object({
    ...READING_SETUP_OPERATION_STREAM_ENVELOPE,
    type: Type.Literal('error'),
    code: ReadingSetupStreamErrorCodeSchema,
    message: Type.String({ minLength: 1 }),
  }),
]);
export type TrialSelectionStreamEvent = Static<typeof TrialSelectionStreamEventSchema>;

export const SubmitTrialFeedbackRequestSchema = Type.Object({
  trialRevisionId: UuidSchema,
  feedback: Type.String({ minLength: 1, maxLength: 4000, pattern: '\\S' }),
  idempotencyKey: IdempotencyKeySchema,
});
export type SubmitTrialFeedbackRequest = Static<typeof SubmitTrialFeedbackRequestSchema>;

export const MarkTrialSegmentViewedRequestSchema = Type.Object({
  trialRevisionId: Type.String(),
  trialSegmentId: Type.String(),
});
export type MarkTrialSegmentViewedRequest = Static<
  typeof MarkTrialSegmentViewedRequestSchema
>;

// No idempotencyKey: adoption is idempotent by state — once active_reading, re-adopting returns
// the existing formal strategy (see adoptTrial), so the key was dead weight. §6.5.
export const AdoptTrialRequestSchema = Type.Object({
  trialRevisionId: Type.String(),
  strategyDraftVersionId: Type.String(),
});
export type AdoptTrialRequest = Static<typeof AdoptTrialRequestSchema>;

export const AdoptTrialResponseSchema = Type.Object({
  userBookId: Type.String(),
  workflowStatus: Type.Literal('active_reading'),
  strategyVersionId: Type.String(),
});
export type AdoptTrialResponse = Static<typeof AdoptTrialResponseSchema>;

// §11.6 — per-user global reader presentation settings. Presentation ONLY: these must never
// feed block enumeration / offset / progress. Persisted server-side (user_reading_settings) and
// cached in localStorage on the client purely for first-paint.
export const ReadingSettingsSchema = Type.Object({
  fontSize: Type.Integer({ minimum: 12, maximum: 40 }),
  lineHeight: Type.Number({ minimum: 1, maximum: 3 }),
  contentWidth: Type.Union([Type.Literal('narrow'), Type.Literal('medium'), Type.Literal('wide')]),
  theme: Type.Union([Type.Literal('system'), Type.Literal('paper'), Type.Literal('night')]),
});
export type ReadingSettings = Static<typeof ReadingSettingsSchema>;

// Shared default so the API (bootstrap fallback when no row exists) and the web client
// (first-paint before bootstrap resolves) never drift.
export const DEFAULT_READING_SETTINGS: ReadingSettings = {
  fontSize: 18,
  lineHeight: 1.95,
  contentWidth: 'medium',
  theme: 'system',
};

export const ReadingSettingsResponseSchema = Type.Object({
  settings: ReadingSettingsSchema,
});
export type ReadingSettingsResponse = Static<typeof ReadingSettingsResponseSchema>;

// §11.5 / §2.5 — a saved reading anchor: block + UTF-16 offset within one reading node. `offset`
// is a single point (the range [start]); highlights carry a full [start,end) range instead.
// `clientObservedAt` is the ISO time the client read this anchor from the DOM (or clicked a TOC
// jump); the server merges position events last-observed-wins by this field, so a stale event that
// arrives late can never overwrite a newer position (reader_position_restore_fix §2.3). The client
// stamps it once at observation time and preserves it across request retries.
export const ReaderPositionSchema = Type.Object({
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
  blockIndex: Type.Integer({ minimum: 1 }),
  offset: Type.Integer({ minimum: 0 }),
  clientObservedAt: Type.String({ format: 'date-time' }),
});
export type ReaderPosition = Static<typeof ReaderPositionSchema>;

// The resume anchor bootstrap delivers carries server-side metadata the restore fallback chain
// needs (§3.3): `nodeOrder` locates the nearest still-valid manifest node when the exact
// section/segment is gone, and `manifestVersion` (null on legacy rows) guards against reinterpreting
// a stale block/offset against a changed block algorithm. Kept separate from the request
// ReaderPosition so DB metadata never leaks into the anchor the client sends back.
export const ReaderResumePositionSchema = Type.Intersect([
  ReaderPositionSchema,
  Type.Object({
    nodeOrder: Type.Integer({ minimum: 1 }),
    manifestVersion: Type.Union([Type.String(), Type.Null()]),
  }),
]);
export type ReaderResumePosition = Static<typeof ReaderResumePositionSchema>;

// §11.4 — a node the reader has marked read (monotonic set; once read never回退).
export const ReadNodeSchema = Type.Object({
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
});
export type ReadNode = Static<typeof ReadNodeSchema>;

// §11.7 — a reader highlight over a [start,end) range within one reading node. `range` is the shared
// TextRange (§2.5), the same coordinate system as annotation anchors and the saved position. A null
// `note` is a plain highlight; non-null is a highlight with a note (there is no bookmark type and no
// standalone-note type — 验收 :1469). `quoteSnapshot` is the standard-text slice captured at highlight
// time, for list display and drift fallback. The server assigns the stable `id` (PRD :1383).
export const HighlightSchema = Type.Object({
  id: Type.String(),
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
  range: TextRangeSchema,
  note: Type.Union([Type.String(), Type.Null()]),
  quoteSnapshot: Type.String(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type Highlight = Static<typeof HighlightSchema>;

// Create a highlight (§11.7). The range must lie within the single section_id+segment node; the
// server validates it against that node's blocks and rejects an out-of-range range outright — no
// fuzzy matching (reading_contract §6, mirroring annotation-anchor resolution). `note` optional:
// omitted → plain highlight, present → highlight with a note in one call.
export const CreateHighlightRequestSchema = Type.Object({
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
  range: TextRangeSchema,
  note: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
});
export type CreateHighlightRequest = Static<typeof CreateHighlightRequestSchema>;

// Edit or clear a highlight's note (§11.7). An empty/blank string or null clears the note but keeps
// the highlight (delete-note ≠ delete-highlight); a non-blank string sets/edits it.
export const UpdateHighlightNoteRequestSchema = Type.Object({
  note: Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
});
export type UpdateHighlightNoteRequest = Static<typeof UpdateHighlightNoteRequestSchema>;

export const HighlightResponseSchema = Type.Object({
  highlight: HighlightSchema,
});
export type HighlightResponse = Static<typeof HighlightResponseSchema>;

export const HighlightListResponseSchema = Type.Object({
  highlights: Type.Array(HighlightSchema),
});
export type HighlightListResponse = Static<typeof HighlightListResponseSchema>;

// DELETE removes the whole row (highlight + its note), so a bare id ack is enough for the client to
// drop it from cache; it never cascades to any 问 AI conversation (§11.7 — conversations snapshot the
// origin range, they don't reference highlights.id).
export const DeleteHighlightResponseSchema = Type.Object({
  id: Type.String(),
});
export type DeleteHighlightResponse = Static<typeof DeleteHighlightResponseSchema>;

// The reader bootstrap the active-reading page loads (§5): the formal shape for what was
// previously served as Type.Unknown(). `briefing` is the structured pre-reading briefing
// (BriefCard sections); `strategySummary` stays a plain string rendered directly.
export const ReaderBootstrapEnhancementSchema = Type.Object({
  generationId: Type.String(),
  strategyVersionId: Type.String(),
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
  status: NodeGenerationStatusSchema,
  result: Type.Union([GenerationResultSchema, Type.Null()]),
});
export type ReaderBootstrapEnhancement = Static<typeof ReaderBootstrapEnhancementSchema>;

export const ReaderBootstrapSchema = Type.Object({
  userBookId: Type.String(),
  sharedBookId: Type.String(),
  workflowStatus: Type.Literal('active_reading'),
  strategyVersionId: Type.String(),
  strategyVersion: Type.Integer({ minimum: 1 }),
  briefing: BriefingSchema,
  strategySummary: Type.String(),
  enhancements: Type.Array(ReaderBootstrapEnhancementSchema),
  // §11.5 last reading position to resume to (null → start from the first node), with the restore
  // metadata (nodeOrder / manifestVersion) the fallback chain needs (§3.3).
  resumePosition: Type.Union([ReaderResumePositionSchema, Type.Null()]),
  // §11.6 the user's global reader settings, delivered with bootstrap to avoid a first-paint round trip.
  settings: ReadingSettingsSchema,
  // §11.4 nodes already marked read (monotonic set).
  readNodes: Type.Array(ReadNodeSchema),
  // §11.7 the book's highlights, delivered with bootstrap so the continuous-scroll reader renders
  // them into the first-paint mark pass without a second round trip.
  highlights: Type.Array(HighlightSchema),
});
export type ReaderBootstrap = Static<typeof ReaderBootstrapSchema>;

// The reader reports its current (or jumped-to) node so the host can keep the
// lazy-loading window (current node + next 3 tailoring-eligible nodes) generating
// and raise priority on the target (§6.2 / PRD §11.3). `order` is a manifest node order.
// The optional `position` carries the full anchor so this same signal also persists the last
// reading position (§11.5); the host grows the window on order change and always saves position.
export const ReaderFocusRequestSchema = Type.Object({
  order: Type.Integer({ minimum: 1 }),
  position: Type.Optional(ReaderPositionSchema),
});
export type ReaderFocusRequest = Static<typeof ReaderFocusRequestSchema>;

// §11.4 — mark a node read. Idempotent, monotonic (server ignores a re-mark).
export const MarkReadNodeRequestSchema = ReadNodeSchema;
export type MarkReadNodeRequest = Static<typeof MarkReadNodeRequestSchema>;

export const MarkReadNodeResponseSchema = Type.Object({
  readNodes: Type.Array(ReadNodeSchema),
});
export type MarkReadNodeResponse = Static<typeof MarkReadNodeResponseSchema>;

export const ReadingActivityAreaSchema = Type.Union([
  Type.Literal('original'),
  Type.Literal('assistance'),
  Type.Literal('reader_chrome'),
]);
export type ReadingActivityArea = Static<typeof ReadingActivityAreaSchema>;

export const ReadingActivityClassificationSchema = Type.Union([
  Type.Literal('original_forward'),
  Type.Literal('original_reread'),
  Type.Literal('original_jump'),
  Type.Literal('assistance'),
  Type.Literal('stationary'),
]);
export type ReadingActivityClassification = Static<typeof ReadingActivityClassificationSchema>;

export const ReadingActivityPositionSchema = Type.Object({
  order: Type.Integer({ minimum: 1 }),
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
  blockIndex: Type.Integer({ minimum: 1 }),
  offset: Type.Integer({ minimum: 0 }),
});
export type ReadingActivityPosition = Static<typeof ReadingActivityPositionSchema>;

// §11.8 — a reading heartbeat for one effective interval. `clientIntervalId` is the client's stable
// idempotency key for a contiguous active period; every heartbeat carries the interval's *cumulative*
// counters (not deltas), so the server upserts by that id and clamps monotonically — a network retry
// of the same interval never double-counts (§11.8「网络重试不得重复累计同一区间」). `effectiveSeconds`
// is all active reading time; `forwardSeconds`/`forwardChars` are the §11.10 speed 分母/分子 — only
// 正常向前读原文 accrues them. `day` is the client's local natural day (YYYY-MM-DD, §10 开放问题 3 取
// 浏览器时区) the interval's新增有效秒 rolls into. `startedAt`/`at` bound the interval (at → endedAt).
export const HeartbeatRequestSchema = Type.Object({
  clientIntervalId: Type.String({ minLength: 8, maxLength: 64 }),
  effectiveSeconds: Type.Integer({ minimum: 0, maximum: 2147483647 }),
  forwardSeconds: Type.Integer({ minimum: 0, maximum: 2147483647 }),
  forwardChars: Type.Integer({ minimum: 0, maximum: 2147483647 }),
  day: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  startedAt: Type.String({ format: 'date-time' }),
  at: Type.String({ format: 'date-time' }),
});
export type HeartbeatRequest = Static<typeof HeartbeatRequestSchema>;

export const HeartbeatResponseSchema = Type.Object({
  accepted: Type.Boolean(),
});
export type HeartbeatResponse = Static<typeof HeartbeatResponseSchema>;

// §10.3 / reading_stats_architecture: an immutable observed activity slice. The client sends facts
// (time span, positions, area, sequence); the server validates, classifies, splits by local day and
// updates aggregate stats. `(user_id, clientSessionId, sequence)` is the idempotency key.
export const ReadingActivitySliceRequestSchema = Type.Object({
  clientSessionId: Type.String({ minLength: 8, maxLength: 64 }),
  sequence: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  sliceStartedAt: Type.String({ format: 'date-time' }),
  sliceEndedAt: Type.String({ format: 'date-time' }),
  timezone: Type.String({ minLength: 1, maxLength: 100 }),
  startPosition: ReadingActivityPositionSchema,
  endPosition: ReadingActivityPositionSchema,
  activityArea: ReadingActivityAreaSchema,
  discontinuous: Type.Optional(Type.Boolean()),
});
export type ReadingActivitySliceRequest = Static<typeof ReadingActivitySliceRequestSchema>;

export const ReadingActivitySliceResponseSchema = Type.Object({
  accepted: Type.Boolean(),
});
export type ReadingActivitySliceResponse = Static<typeof ReadingActivitySliceResponseSchema>;

// §11.9 — the client passes its own local `day` and week start (Monday) so 今日/本周 respect the
// user's timezone; the server can't know the client's calendar boundaries otherwise. 连续阅读天数 is
// computed relative to `day` from the set of days that have any effective reading.
export const ReadingStatsQuerySchema = Type.Object({
  day: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
  weekStart: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
});
export type ReadingStatsQuery = Static<typeof ReadingStatsQuerySchema>;

// §11.9 global stats: 今日 / 本周 / 累计有效时长 + 当前连续阅读天数. Sourced from daily_reading_totals so
// the累计 and streak survive a book deletion (PRD :1204).
export const ReadingStatsGlobalSchema = Type.Object({
  todaySeconds: Type.Integer({ minimum: 0 }),
  weekSeconds: Type.Integer({ minimum: 0 }),
  totalSeconds: Type.Integer({ minimum: 0 }),
  streakDays: Type.Integer({ minimum: 0 }),
});
export type ReadingStatsGlobal = Static<typeof ReadingStatsGlobalSchema>;

// §11.10 estimated remaining time for one book: 剩余原文字符 ÷ 有效阅读速度. `seconds` is null only when
// the manifest can't be read; `approximate` is true when the estimate uses the language default speed
// (insufficient personal sample) and false once the book's own forward-reading speed takes over.
export const RemainingReadingTimeSchema = Type.Object({
  seconds: Type.Union([Type.Number(), Type.Null()]),
  approximate: Type.Boolean(),
});
export type RemainingReadingTime = Static<typeof RemainingReadingTimeSchema>;

// §11.9 per-book stats: 累计有效时长 / 最近阅读时间 / 当前全书进度 / 预计剩余阅读时间. Progress and
// remainingCharacters reuse the reader's whole-node charactersBefore/total 口径 (§11.10, 只算原文);
// remainingCharacters is null when the manifest has no character statistics. `lastReadAt` is the
// latest session's end (null → never read).
export const ReadingStatsPerBookSchema = Type.Object({
  totalEffectiveSeconds: Type.Integer({ minimum: 0 }),
  lastReadAt: Type.Union([Type.String(), Type.Null()]),
  progressPercent: Type.Integer({ minimum: 0, maximum: 100 }),
  remainingCharacters: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  remaining: RemainingReadingTimeSchema,
});
export type ReadingStatsPerBook = Static<typeof ReadingStatsPerBookSchema>;

export const ContentGenerationJobPayloadSchema = Type.Object({
  kind: Type.Literal('content.generate'),
  generationId: Type.String(),
  userBookId: Type.String(),
  scope: GenerationScopeSchema,
  requestedAt: Type.String(),
});
export type ContentGenerationJobPayload = Static<
  typeof ContentGenerationJobPayloadSchema
>;

export const UserBookShelfItemSchema = Type.Object({
  id: Type.String(),
  sharedBookId: Type.String(),
  sharedBookStatus: SharedBookStatusSchema,
  workflowStatus: UserBookWorkflowStatusSchema,
  title: Type.String(),
  authors: Type.Array(Type.String()),
  coverPath: Type.Union([Type.String(), Type.Null()]),
  errorSummary: Type.Union([Type.String(), Type.Null()]),
  failureType: Type.Union([NormalizationFailureTypeSchema, Type.Null()]),
  progress: Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Null()]),
  lastActivityAt: Type.String(),
});
export type UserBookShelfItem = Static<typeof UserBookShelfItemSchema>;

export const UserBookShelfResponseSchema = Type.Object({
  books: Type.Array(UserBookShelfItemSchema),
});
export type UserBookShelfResponse = Static<typeof UserBookShelfResponseSchema>;

export const UserBookDetailSchema = Type.Object({
  book: UserBookShelfItemSchema,
  currentInterviewSessionId: Type.Union([Type.String(), Type.Null()]),
  currentBookReaderProfileVersionId: Type.Union([Type.String(), Type.Null()]),
  currentStrategyDraftVersionId: Type.Union([Type.String(), Type.Null()]),
  currentStrategyVersionId: Type.Union([Type.String(), Type.Null()]),
  currentTrialRevisionId: Type.Union([Type.String(), Type.Null()]),
  adjustmentCount: Type.Integer({ minimum: 0, maximum: 5 }),
  deletedAt: Type.Union([Type.String(), Type.Null()]),
  purgeAfter: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type UserBookDetail = Static<typeof UserBookDetailSchema>;

export const UserBookDetailResponseSchema = UserBookDetailSchema;
export type UserBookDetailResponse = UserBookDetail;

export * from './agent-driven-reading-setup';
