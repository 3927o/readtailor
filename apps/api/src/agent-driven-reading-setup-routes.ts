/** Registers the HTTP and SSE boundary for agent-driven reading setup. */

import { Readable } from 'node:stream';
import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import {
  ConfirmReadingSetupRequestSchema,
  ConfirmReadingSetupResponseSchema,
  ErrorResponseSchema,
  StartAgentRunResponseSchema,
  SubmitAgentMessageRequestSchema,
  SubmitAgentQuestionAnswerRequestSchema,
} from '@readtailor/contracts';
import {
  AgentDrivenReadingSetupError,
  type AgentDrivenReadingSetupService,
} from './agent-driven-reading-setup';
import { withHeartbeat } from './sse';

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const userBookIdParams = Type.Object({
  id: Type.String({ pattern: UUID_PATTERN }),
});
const readingSetupSessionParams = Type.Object({
  sessionId: Type.String({ pattern: UUID_PATTERN }),
});
const readingSetupRunParams = Type.Object({
  sessionId: Type.String({ pattern: UUID_PATTERN }),
  runId: Type.String({ pattern: UUID_PATTERN }),
});

// fast-json-stringify cannot compile a recursive JSON-value schema when that schema appears
// at several positions in one response. The HTTP projection remains intentionally non-recursive.
const agentRunDisplaySnapshotResponseSchema = Type.Object({
  runId: Type.String({ pattern: UUID_PATTERN }),
  lastSequence: Type.Integer({ minimum: 0 }),
  status: Type.Union([
    Type.Literal('queued'),
    Type.Literal('running'),
    Type.Literal('completed'),
    Type.Literal('failed'),
  ]),
  assistantText: Type.String(),
  assistantMessage: Type.Any(),
  tools: Type.Array(Type.Any()),
  error: Type.Union([Type.String(), Type.Null()]),
});
const readingSetupSessionSnapshotResponseSchema = Type.Object({
  id: Type.String({ pattern: UUID_PATTERN }),
  userBookId: Type.String({ pattern: UUID_PATTERN }),
  agentType: Type.Literal('reading_setup'),
  agentState: Type.Any(),
  activeRun: Type.Union([
    Type.Object({
      runId: Type.String({ pattern: UUID_PATTERN }),
      status: Type.Union([
        Type.Literal('queued'),
        Type.Literal('running'),
        Type.Literal('completed'),
        Type.Literal('failed'),
      ]),
      snapshot: Type.Union([agentRunDisplaySnapshotResponseSchema, Type.Null()]),
    }),
    Type.Null(),
  ]),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});

function readingSetupFailure(
  error: unknown,
  reply: { code(statusCode: number): unknown },
): { error: string } {
  if (error instanceof AgentDrivenReadingSetupError) {
    reply.code(error.statusCode);
    return { error: error.message };
  }
  throw error;
}

export const agentDrivenReadingSetupRoutes: FastifyPluginAsyncTypebox<{
  service: AgentDrivenReadingSetupService | undefined;
}> = async (app, options) => {
  app.post(
    '/v1/user-books/:id/reading-setup/session',
    {
      schema: {
        params: userBookIdParams,
        response: {
          200: readingSetupSessionSnapshotResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!options.service) return reply.code(503).send({ error: '阅读准备未配置' });
      try {
        return await options.service.getOrCreateSession(
          request.authUser!.id,
          request.params.id,
        );
      } catch (error) {
        return readingSetupFailure(error, reply);
      }
    },
  );

  app.get(
    '/v1/reading-setup/sessions/:sessionId',
    {
      schema: {
        params: readingSetupSessionParams,
        response: {
          200: readingSetupSessionSnapshotResponseSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!options.service) return reply.code(503).send({ error: '阅读准备未配置' });
      try {
        return await options.service.getSession(
          request.authUser!.id,
          request.params.sessionId,
        );
      } catch (error) {
        return readingSetupFailure(error, reply);
      }
    },
  );

  app.post(
    '/v1/reading-setup/sessions/:sessionId/messages',
    {
      schema: {
        params: readingSetupSessionParams,
        body: SubmitAgentMessageRequestSchema,
        response: {
          202: StartAgentRunResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!options.service) return reply.code(503).send({ error: '阅读准备未配置' });
      try {
        const result = await options.service.submitMessage(
          request.authUser!.id,
          request.params.sessionId,
          request.body.message,
        );
        return reply.code(202).send(result);
      } catch (error) {
        return readingSetupFailure(error, reply);
      }
    },
  );

  app.post(
    '/v1/reading-setup/sessions/:sessionId/question-answers',
    {
      schema: {
        params: readingSetupSessionParams,
        body: SubmitAgentQuestionAnswerRequestSchema,
        response: {
          202: StartAgentRunResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!options.service) return reply.code(503).send({ error: '阅读准备未配置' });
      try {
        const result = await options.service.submitQuestionAnswer(
          request.authUser!.id,
          request.params.sessionId,
          request.body,
        );
        return reply.code(202).send(result);
      } catch (error) {
        return readingSetupFailure(error, reply);
      }
    },
  );

  app.get(
    '/v1/reading-setup/sessions/:sessionId/runs/:runId',
    {
      schema: {
        params: readingSetupRunParams,
        response: {
          200: agentRunDisplaySnapshotResponseSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!options.service) return reply.code(503).send({ error: '阅读准备未配置' });
      try {
        return await options.service.getRunSnapshot(
          request.authUser!.id,
          request.params.sessionId,
          request.params.runId,
        );
      } catch (error) {
        return readingSetupFailure(error, reply);
      }
    },
  );

  app.get(
    '/v1/reading-setup/sessions/:sessionId/runs/:runId/events',
    { schema: { params: readingSetupRunParams } },
    async (request, reply) => {
      if (!options.service) return reply.code(503).send({ error: '阅读准备未配置' });
      const events = options.service.subscribeRun(
        request.authUser!.id,
        request.params.sessionId,
        request.params.runId,
      );
      let first;
      try {
        first = await events.next();
      } catch (error) {
        return readingSetupFailure(error, reply);
      }
      const encode = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
      const source = async function* () {
        if (!first.done) yield encode(first.value);
        for await (const event of events) yield encode(event);
      };
      return reply
        .type('text/event-stream')
        .header('cache-control', 'private, no-store')
        .header('x-accel-buffering', 'no')
        .send(Readable.from(withHeartbeat(source(), 15_000)));
    },
  );

  app.post(
    '/v1/reading-setup/sessions/:sessionId/confirm',
    {
      schema: {
        params: readingSetupSessionParams,
        body: ConfirmReadingSetupRequestSchema,
        response: {
          200: ConfirmReadingSetupResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          409: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!options.service) return reply.code(503).send({ error: '阅读准备未配置' });
      try {
        return await options.service.confirm(
          request.authUser!.id,
          request.params.sessionId,
          request.body.offerToolCallId,
        );
      } catch (error) {
        return readingSetupFailure(error, reply);
      }
    },
  );
};
