import { type Static, Type } from '@sinclair/typebox';

export const HealthResponseSchema = Type.Object({
  service: Type.String(),
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  version: Type.String(),
  timestamp: Type.String(),
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
