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
