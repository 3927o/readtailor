import { type Static, Type } from '@sinclair/typebox';

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

export const BookReaderProfileSchema = Type.Object({
  purpose: Type.String({ minLength: 1 }),
  existingKnowledge: Type.Array(Type.String({ minLength: 1 })),
  desiredDepthOrOutcome: Type.String({ minLength: 1 }),
  likelyObstacles: Type.Array(Type.String({ minLength: 1 })),
  expectedCommitment: Type.String({ minLength: 1 }),
  otherConclusions: Type.Array(Type.String({ minLength: 1 })),
});
export type BookReaderProfile = Static<typeof BookReaderProfileSchema>;

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
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});
export type SubmitInterviewAnswerRequest = Static<
  typeof SubmitInterviewAnswerRequestSchema
>;

export const InterviewStateResponseSchema = Type.Object({
  sessionId: Type.String(),
  status: InterviewSessionStatusSchema,
  questionCount: Type.Integer({ minimum: 0, maximum: 7 }),
  maxQuestions: Type.Literal(7),
  currentQuestion: Type.Union([InterviewQuestionSchema, Type.Null()]),
  // Current question's self-assessed sufficiency, surfaced top-level so the non-streaming
  // fallback (GET /interview) can render the progress bar without a live SSE stream.
  sufficiency: Type.Union([Type.Integer({ minimum: 0, maximum: 100 }), Type.Null()]),
  answers: Type.Array(InterviewAnswerSchema),
});
export type InterviewStateResponse = Static<typeof InterviewStateResponseSchema>;

// SSE wire events for the streaming interview endpoint (§4.2). Each frame is
// `data: <json>\n\n` with the discriminator in `type`, mirroring the system-chat stream.
// The stream bypasses Fastify serialization, so this is a hand-maintained union rather than
// a validated TypeBox schema. ack/prompt/option/sufficiency/concluding are token-level
// deltas; question_final delivers the authoritative next question; done ends the turn;
// error reports an in-band failure after the stream has opened.
export type InterviewStreamEvent =
  | { type: 'ack_delta'; chars: string }
  | { type: 'prompt_delta'; chars: string }
  | { type: 'hint_delta'; chars: string }
  | { type: 'option_added'; id: string; label: string }
  | { type: 'sufficiency'; value: number }
  | { type: 'concluding' }
  | { type: 'question_final'; question: InterviewQuestion; ordinal: number; maxQuestions: number }
  | { type: 'done'; workflowStatus: UserBookWorkflowStatus }
  | { type: 'error'; message: string };

export const TextPositionSchema = Type.Object({
  blockIndex: Type.Integer({ minimum: 1 }),
  offset: Type.Integer({ minimum: 0 }),
});
export type TextPosition = Static<typeof TextPositionSchema>;

export const TextRangeSchema = Type.Object({
  start: TextPositionSchema,
  end: TextPositionSchema,
});
export type TextRange = Static<typeof TextRangeSchema>;

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

export const StrategySchema = Type.Object({
  goals: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  expressionPrinciples: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  guide: Type.Object({
    enabled: Type.Boolean(),
    objectives: Type.Array(Type.String({ minLength: 1 })),
  }),
  annotations: Type.Object({
    enabled: Type.Boolean(),
    focuses: Type.Array(Type.String({ minLength: 1 })),
    exclusions: Type.Array(Type.String({ minLength: 1 })),
  }),
  afterReading: Type.Object({
    enabled: Type.Boolean(),
    objectives: Type.Array(Type.String({ minLength: 1 })),
  }),
  trialCandidates: Type.Array(TrialCandidateSchema, { minItems: 3, maxItems: 3 }),
});
export type Strategy = Static<typeof StrategySchema>;

export const StrategyDraftStatusSchema = Type.Union([
  Type.Literal('draft'),
  Type.Literal('approved_for_trial'),
  Type.Literal('confirmed'),
  Type.Literal('superseded'),
]);
export type StrategyDraftStatus = Static<typeof StrategyDraftStatusSchema>;

export const StrategyDraftSchema = Type.Object({
  id: Type.String(),
  version: Type.Integer({ minimum: 1 }),
  status: StrategyDraftStatusSchema,
  readingBriefing: Type.String({ minLength: 1 }),
  userFacingSummary: Type.String({ minLength: 1 }),
  strategy: StrategySchema,
  createdAt: Type.String(),
  approvedForTrialAt: Type.Union([Type.String(), Type.Null()]),
});
export type StrategyDraft = Static<typeof StrategyDraftSchema>;

export const StrategyReviewResponseSchema = Type.Object({
  userBookId: Type.String(),
  workflowStatus: UserBookWorkflowStatusSchema,
  draft: StrategyDraftSchema,
  adjustmentCount: Type.Integer({ minimum: 0, maximum: 5 }),
  adjustmentLimit: Type.Integer({ minimum: 1 }),
  canAdjust: Type.Boolean(),
});
export type StrategyReviewResponse = Static<typeof StrategyReviewResponseSchema>;

export const SubmitStrategyFeedbackRequestSchema = Type.Object({
  strategyDraftVersionId: Type.String(),
  feedback: Type.String({ minLength: 1, maxLength: 4000 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});
export type SubmitStrategyFeedbackRequest = Static<
  typeof SubmitStrategyFeedbackRequestSchema
>;

export const ApproveStrategyRequestSchema = Type.Object({
  strategyDraftVersionId: Type.String(),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});
export type ApproveStrategyRequest = Static<typeof ApproveStrategyRequestSchema>;

export const ApproveStrategyResponseSchema = Type.Object({
  userBookId: Type.String(),
  workflowStatus: UserBookWorkflowStatusSchema,
  strategyDraftVersionId: Type.String(),
  trialRevisionId: Type.String(),
});
export type ApproveStrategyResponse = Static<typeof ApproveStrategyResponseSchema>;

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

export const TrialSegmentSchema = Type.Object({
  id: Type.String(),
  ordinal: Type.Integer({ minimum: 1, maximum: 3 }),
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
  range: TextRangeSchema,
  chapterPath: Type.Array(Type.String({ minLength: 1 })),
  originalHtml: Type.String({ minLength: 1 }),
  selectionReason: Type.String({ minLength: 1 }),
  status: TrialSegmentStatusSchema,
  result: Type.Union([GenerationResultSchema, Type.Null()]),
  viewedAt: Type.Union([Type.String(), Type.Null()]),
});
export type TrialSegment = Static<typeof TrialSegmentSchema>;

export const TrialReviewResponseSchema = Type.Object({
  userBookId: Type.String(),
  workflowStatus: UserBookWorkflowStatusSchema,
  trialRevisionId: Type.String(),
  revision: Type.Integer({ minimum: 1 }),
  status: TrialRevisionStatusSchema,
  strategyDraftVersionId: Type.String(),
  segments: Type.Array(TrialSegmentSchema, { minItems: 3, maxItems: 3 }),
  adjustmentCount: Type.Integer({ minimum: 0, maximum: 5 }),
  adjustmentLimit: Type.Integer({ minimum: 1 }),
  canAdjust: Type.Boolean(),
  canAdopt: Type.Boolean(),
});
export type TrialReviewResponse = Static<typeof TrialReviewResponseSchema>;

export const SubmitTrialFeedbackRequestSchema = Type.Object({
  trialRevisionId: Type.String(),
  feedback: Type.String({ minLength: 1, maxLength: 4000 }),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});
export type SubmitTrialFeedbackRequest = Static<typeof SubmitTrialFeedbackRequestSchema>;

export const MarkTrialSegmentViewedRequestSchema = Type.Object({
  trialRevisionId: Type.String(),
  trialSegmentId: Type.String(),
});
export type MarkTrialSegmentViewedRequest = Static<
  typeof MarkTrialSegmentViewedRequestSchema
>;

export const AdoptTrialRequestSchema = Type.Object({
  trialRevisionId: Type.String(),
  strategyDraftVersionId: Type.String(),
  idempotencyKey: Type.String({ minLength: 1, maxLength: 200 }),
});
export type AdoptTrialRequest = Static<typeof AdoptTrialRequestSchema>;

export const AdoptTrialResponseSchema = Type.Object({
  userBookId: Type.String(),
  workflowStatus: Type.Literal('active_reading'),
  strategyVersionId: Type.String(),
});
export type AdoptTrialResponse = Static<typeof AdoptTrialResponseSchema>;

// The reader bootstrap the active-reading page loads (§5): the formal shape for what was
// previously served as Type.Unknown(). `briefing` / `strategySummary` are plain strings —
// the frontend renders them directly instead of fabricating a structured briefing.
export const ReaderBootstrapEnhancementSchema = Type.Object({
  generationId: Type.String(),
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
  briefing: Type.String(),
  strategySummary: Type.String(),
  enhancements: Type.Array(ReaderBootstrapEnhancementSchema),
});
export type ReaderBootstrap = Static<typeof ReaderBootstrapSchema>;

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

export const UserBookWorkflowResponseSchema = Type.Object({
  workflowStatus: UserBookWorkflowStatusSchema,
  book: UserBookShelfItemSchema,
  interview: Type.Union([InterviewStateResponseSchema, Type.Null()]),
  strategy: Type.Union([StrategyReviewResponseSchema, Type.Null()]),
  trial: Type.Union([TrialReviewResponseSchema, Type.Null()]),
});
export type UserBookWorkflowResponse = Static<typeof UserBookWorkflowResponseSchema>;
