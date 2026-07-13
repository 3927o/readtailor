import { type Static, Type } from '@sinclair/typebox';

export const HealthResponseSchema = Type.Object({
  service: Type.String(),
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded')]),
  version: Type.String(),
  timestamp: Type.String(),
});
export type HealthResponse = Static<typeof HealthResponseSchema>;

export const SystemJobPayloadSchema = Type.Object({
  kind: Type.Literal('system.ping'),
  requestedAt: Type.String(),
});
export type SystemJobPayload = Static<typeof SystemJobPayloadSchema>;
