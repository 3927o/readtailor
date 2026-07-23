/** Defines agent-driven reading-setup wire contracts and generic Agent run transport DTOs. */

import { type Static, Type } from '@sinclair/typebox';
import {
  BookReaderProfileSchema,
  BriefingSchema,
  ProposedStrategySchema,
} from './reading-setup';

const AgentUuidSchema = Type.String({
  pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
});

export const AGENT_SESSION_STATE_MAX_BYTES = 2 * 1024 * 1024;
export const AGENT_TOOL_ARGUMENTS_MAX_BYTES = 128 * 1024;
export const AGENT_TOOL_RESULT_MAX_BYTES = 256 * 1024;
export const AGENT_READ_RESULT_MAX_BYTES = 50 * 1024;

export const AgentJsonValueSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Self),
    Type.Record(Type.String(), Self),
  ]),
);
export type AgentJsonValue = Static<typeof AgentJsonValueSchema>;

export const AgentThinkingLevelSchema = Type.Union([
  Type.Literal('off'),
  Type.Literal('minimal'),
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
]);
export type AgentThinkingLevel = Static<typeof AgentThinkingLevelSchema>;

export const AgentTextContentSchema = Type.Object({
  type: Type.Literal('text'),
  text: Type.String(),
  textSignature: Type.Optional(Type.String()),
});

export const AgentThinkingContentSchema = Type.Object({
  type: Type.Literal('thinking'),
  thinking: Type.String(),
  thinkingSignature: Type.Optional(Type.String()),
  redacted: Type.Optional(Type.Boolean()),
});

export const AgentToolCallContentSchema = Type.Object({
  type: Type.Literal('toolCall'),
  id: Type.String({ minLength: 1, maxLength: 200 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  arguments: AgentJsonValueSchema,
  thoughtSignature: Type.Optional(Type.String()),
});

export const AgentUsageSchema = Type.Object({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
  cacheWrite1h: Type.Optional(Type.Number({ minimum: 0 })),
  reasoning: Type.Optional(Type.Number({ minimum: 0 })),
  totalTokens: Type.Number({ minimum: 0 }),
  cost: Type.Object({
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }),
    cacheWrite: Type.Number({ minimum: 0 }),
    total: Type.Number({ minimum: 0 }),
  }),
});

export const AgentUserMessageSchema = Type.Object({
  role: Type.Literal('user'),
  content: Type.Union([Type.String(), Type.Array(AgentTextContentSchema)]),
  timestamp: Type.Number({ minimum: 0 }),
});

export const AgentAssistantMessageSchema = Type.Object({
  role: Type.Literal('assistant'),
  content: Type.Array(
    Type.Union([
      AgentTextContentSchema,
      AgentThinkingContentSchema,
      AgentToolCallContentSchema,
    ]),
  ),
  api: Type.String({ minLength: 1 }),
  provider: Type.String({ minLength: 1 }),
  model: Type.String({ minLength: 1 }),
  responseModel: Type.Optional(Type.String()),
  responseId: Type.Optional(Type.String()),
  diagnostics: Type.Optional(Type.Array(AgentJsonValueSchema)),
  usage: AgentUsageSchema,
  stopReason: Type.Union([
    Type.Literal('stop'),
    Type.Literal('length'),
    Type.Literal('toolUse'),
    Type.Literal('error'),
    Type.Literal('aborted'),
  ]),
  errorMessage: Type.Optional(Type.String()),
  timestamp: Type.Number({ minimum: 0 }),
});

export const AgentToolResultMessageSchema = Type.Object({
  role: Type.Literal('toolResult'),
  toolCallId: Type.String({ minLength: 1, maxLength: 200 }),
  toolName: Type.String({ minLength: 1, maxLength: 200 }),
  content: Type.Array(AgentTextContentSchema),
  details: Type.Optional(AgentJsonValueSchema),
  isError: Type.Boolean(),
  timestamp: Type.Number({ minimum: 0 }),
});

export const AgentMessageSchema = Type.Union([
  AgentUserMessageSchema,
  AgentAssistantMessageSchema,
  AgentToolResultMessageSchema,
]);
export type AgentMessageDto = Static<typeof AgentMessageSchema>;

export const AgentQuestionAnswerActionSchema = Type.Object({
  type: Type.Literal('question_answer'),
  questionToolCallId: Type.String({ minLength: 1, maxLength: 200 }),
  selectedOptionIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    maxItems: 20,
  }),
  freeText: Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
  submittedAt: Type.String(),
});

export const AgentStrategyConfirmationActionSchema = Type.Object({
  type: Type.Literal('strategy_confirmation'),
  strategyToolCallId: Type.String({ minLength: 1, maxLength: 200 }),
  submittedAt: Type.String(),
});

export const AgentTrialConfirmationActionSchema = Type.Object({
  type: Type.Literal('trial_confirmation'),
  trialToolCallId: Type.String({ minLength: 1, maxLength: 200 }),
  submittedAt: Type.String(),
  result: Type.Object({
    userBookId: AgentUuidSchema,
    workflowStatus: Type.Literal('active_reading'),
    strategyVersionId: AgentUuidSchema,
  }),
});

export const AgentActionSchema = Type.Union([
  AgentQuestionAnswerActionSchema,
  AgentStrategyConfirmationActionSchema,
  AgentTrialConfirmationActionSchema,
]);
export type AgentAction = Static<typeof AgentActionSchema>;

export const AgentSessionStateSchema = Type.Object({
  systemPrompt: Type.String({ minLength: 1 }),
  modelConfigId: Type.String({ minLength: 1, maxLength: 500 }),
  thinkingLevel: AgentThinkingLevelSchema,
  messages: Type.Array(AgentMessageSchema),
  actions: Type.Array(AgentActionSchema),
});
export type AgentSessionState = Static<typeof AgentSessionStateSchema>;

export const AgentRunStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('completed'),
  Type.Literal('failed'),
]);
export type AgentRunStatus = Static<typeof AgentRunStatusSchema>;

export const AgentRunToolDisplaySchema = Type.Object({
  toolCallId: Type.String(),
  toolName: Type.String(),
  argumentsBuffer: Type.String(),
  arguments: Type.Union([AgentJsonValueSchema, Type.Null()]),
  callFinished: Type.Boolean(),
  executionStatus: Type.Union([
    Type.Literal('pending'),
    Type.Literal('running'),
    Type.Literal('completed'),
  ]),
  result: Type.Union([AgentJsonValueSchema, Type.Null()]),
  isError: Type.Boolean(),
});
export type AgentRunToolDisplay = Static<typeof AgentRunToolDisplaySchema>;

export const AgentRunDisplaySnapshotSchema = Type.Object({
  runId: AgentUuidSchema,
  lastSequence: Type.Integer({ minimum: 0 }),
  status: AgentRunStatusSchema,
  assistantText: Type.String(),
  assistantMessage: Type.Union([AgentAssistantMessageSchema, Type.Null()]),
  tools: Type.Array(AgentRunToolDisplaySchema),
  error: Type.Union([Type.String(), Type.Null()]),
});
export type AgentRunDisplaySnapshot = Static<typeof AgentRunDisplaySnapshotSchema>;

export const ActiveAgentRunSchema = Type.Object({
  runId: AgentUuidSchema,
  status: AgentRunStatusSchema,
  snapshot: Type.Union([AgentRunDisplaySnapshotSchema, Type.Null()]),
});
export type ActiveAgentRun = Static<typeof ActiveAgentRunSchema>;

export const ReadingSetupSessionSnapshotSchema = Type.Object({
  id: AgentUuidSchema,
  userBookId: AgentUuidSchema,
  agentType: Type.Literal('reading_setup'),
  agentState: AgentSessionStateSchema,
  activeRun: Type.Union([ActiveAgentRunSchema, Type.Null()]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
export type ReadingSetupSessionSnapshot = Static<
  typeof ReadingSetupSessionSnapshotSchema
>;

const SEQUENCED_EVENT_FIELDS = {
  runId: AgentUuidSchema,
  sequence: Type.Integer({ minimum: 1 }),
};

export const AgentRunSnapshotEventSchema = Type.Object({
  type: Type.Literal('run_snapshot'),
  runId: AgentUuidSchema,
  snapshot: AgentRunDisplaySnapshotSchema,
});
export const AgentAssistantTextDeltaEventSchema = Type.Object({
  ...SEQUENCED_EVENT_FIELDS,
  type: Type.Literal('assistant_text_delta'),
  delta: Type.String(),
});
export const AgentToolCallStartedEventSchema = Type.Object({
  ...SEQUENCED_EVENT_FIELDS,
  type: Type.Literal('tool_call_started'),
  toolCallId: Type.String(),
  toolName: Type.String(),
});
export const AgentToolCallArgumentsDeltaEventSchema = Type.Object({
  ...SEQUENCED_EVENT_FIELDS,
  type: Type.Literal('tool_call_arguments_delta'),
  toolCallId: Type.String(),
  delta: Type.String(),
});
export const AgentToolCallFinishedEventSchema = Type.Object({
  ...SEQUENCED_EVENT_FIELDS,
  type: Type.Literal('tool_call_finished'),
  toolCallId: Type.String(),
  toolName: Type.String(),
  arguments: AgentJsonValueSchema,
});
export const AgentAssistantMessageFinishedEventSchema = Type.Object({
  ...SEQUENCED_EVENT_FIELDS,
  type: Type.Literal('assistant_message_finished'),
  message: AgentAssistantMessageSchema,
});
export const AgentToolExecutionStartedEventSchema = Type.Object({
  ...SEQUENCED_EVENT_FIELDS,
  type: Type.Literal('tool_execution_started'),
  toolCallId: Type.String(),
  toolName: Type.String(),
});
export const AgentToolExecutionProgressEventSchema = Type.Object({
  ...SEQUENCED_EVENT_FIELDS,
  type: Type.Literal('tool_execution_progress'),
  toolCallId: Type.String(),
  progress: AgentJsonValueSchema,
});
export const AgentToolExecutionFinishedEventSchema = Type.Object({
  ...SEQUENCED_EVENT_FIELDS,
  type: Type.Literal('tool_execution_finished'),
  toolCallId: Type.String(),
  result: AgentJsonValueSchema,
  isError: Type.Boolean(),
});
export const AgentRunFinishedEventSchema = Type.Object({
  ...SEQUENCED_EVENT_FIELDS,
  type: Type.Literal('run_finished'),
  status: Type.Union([Type.Literal('completed'), Type.Literal('failed')]),
  error: Type.Optional(Type.String()),
});

export const AgentRunEventSchema = Type.Union([
  AgentRunSnapshotEventSchema,
  AgentAssistantTextDeltaEventSchema,
  AgentToolCallStartedEventSchema,
  AgentToolCallArgumentsDeltaEventSchema,
  AgentToolCallFinishedEventSchema,
  AgentAssistantMessageFinishedEventSchema,
  AgentToolExecutionStartedEventSchema,
  AgentToolExecutionProgressEventSchema,
  AgentToolExecutionFinishedEventSchema,
  AgentRunFinishedEventSchema,
]);
export type AgentRunEvent = Static<typeof AgentRunEventSchema>;
export type AgentSequencedRunEvent = Exclude<AgentRunEvent, { type: 'run_snapshot' }>;

export const AgentRunInputSchema = Type.Union([
  Type.Object({
    type: Type.Literal('session_start'),
  }),
  Type.Object({
    type: Type.Literal('message'),
    text: Type.String({ minLength: 1, maxLength: 8000 }),
  }),
  Type.Object({
    type: Type.Literal('question_answer'),
    questionToolCallId: Type.String({ minLength: 1, maxLength: 200 }),
    selectedOptionIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 20,
    }),
    freeText: Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
  }),
  Type.Object({
    type: Type.Literal('strategy_confirmation'),
    strategyToolCallId: Type.String({ minLength: 1, maxLength: 200 }),
  }),
]);
export type AgentRunInput = Static<typeof AgentRunInputSchema>;

export const AgentRunJobPayloadSchema = Type.Object({
  agentType: Type.String({ minLength: 1, maxLength: 100 }),
  sessionId: AgentUuidSchema,
  runId: AgentUuidSchema,
  input: AgentJsonValueSchema,
});
export type AgentRunJobPayload = Static<typeof AgentRunJobPayloadSchema>;

export const SubmitAgentMessageRequestSchema = Type.Object({
  message: Type.String({ minLength: 1, maxLength: 8000 }),
});
export type SubmitAgentMessageRequest = Static<typeof SubmitAgentMessageRequestSchema>;

export const SubmitAgentQuestionAnswerRequestSchema = Type.Object({
  questionToolCallId: Type.String({ minLength: 1, maxLength: 200 }),
  selectedOptionIds: Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
    maxItems: 20,
  }),
  freeText: Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
});
export type SubmitAgentQuestionAnswerRequest = Static<
  typeof SubmitAgentQuestionAnswerRequestSchema
>;

export const SubmitAgentStrategyConfirmationRequestSchema = Type.Object({
  strategyToolCallId: Type.String({ minLength: 1, maxLength: 200 }),
});
export type SubmitAgentStrategyConfirmationRequest = Static<
  typeof SubmitAgentStrategyConfirmationRequestSchema
>;

export const StartAgentRunResponseSchema = Type.Object({
  runId: AgentUuidSchema,
  accepted: Type.Boolean(),
});
export type StartAgentRunResponse = Static<typeof StartAgentRunResponseSchema>;

export const ConfirmReadingSetupRequestSchema = Type.Object({
  trialToolCallId: Type.String({ minLength: 1, maxLength: 200 }),
});
export type ConfirmReadingSetupRequest = Static<
  typeof ConfirmReadingSetupRequestSchema
>;

export const ConfirmReadingSetupResponseSchema = Type.Object({
  userBookId: AgentUuidSchema,
  workflowStatus: Type.Literal('active_reading'),
  strategyVersionId: AgentUuidSchema,
});
export type ConfirmReadingSetupResponse = Static<
  typeof ConfirmReadingSetupResponseSchema
>;

export const PresentQuestionArgumentsSchema = Type.Object({
  prompt: Type.String({ minLength: 1, maxLength: 1000 }),
  hint: Type.Optional(Type.String({ maxLength: 500 })),
  options: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 200 }),
      label: Type.String({ minLength: 1, maxLength: 300 }),
    }),
    { maxItems: 20 },
  ),
  selectionMode: Type.Union([Type.Literal('single'), Type.Literal('multiple')]),
  allowFreeText: Type.Boolean(),
});
export type PresentQuestionArguments = Static<typeof PresentQuestionArgumentsSchema>;

export const PublishBriefArgumentsSchema = Type.Object({ brief: BriefingSchema });
export type PublishBriefArguments = Static<typeof PublishBriefArgumentsSchema>;
export const PublishBookReaderProfileArgumentsSchema = Type.Object({
  profile: BookReaderProfileSchema,
});
export type PublishBookReaderProfileArguments = Static<
  typeof PublishBookReaderProfileArgumentsSchema
>;
export const PublishStrategyArgumentsSchema = Type.Object({
  briefToolCallId: Type.String({ minLength: 1, maxLength: 200 }),
  bookReaderProfileToolCallId: Type.String({ minLength: 1, maxLength: 200 }),
  summary: Type.String({ minLength: 1, maxLength: 4000 }),
  strategy: ProposedStrategySchema,
});
export type PublishStrategyArguments = Static<typeof PublishStrategyArgumentsSchema>;

export const GenerateTrialSliceArgumentsSchema = Type.Object({
  strategyToolCallId: Type.String({ minLength: 1, maxLength: 200 }),
  sectionId: Type.String({ minLength: 1, maxLength: 500 }),
  segment: Type.Integer({ minimum: 1 }),
  range: Type.Object({
    start: Type.Object({
      blockIndex: Type.Integer({ minimum: 1 }),
      offset: Type.Integer({ minimum: 0 }),
    }),
    end: Type.Object({
      blockIndex: Type.Integer({ minimum: 1 }),
      offset: Type.Integer({ minimum: 0 }),
    }),
  }),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
});
export type GenerateTrialSliceArguments = Static<typeof GenerateTrialSliceArgumentsSchema>;
