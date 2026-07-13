import cors from '@fastify/cors';
import Fastify from 'fastify';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  EnqueueSystemPingResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  SystemJobSchema,
} from '@readtailor/contracts';
import { createLogger } from '@readtailor/observability';
import type { ApiConfig } from './config';
import type { SystemJobService } from './system-jobs';

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

export interface AppDeps {
  systemJobs?: SystemJobService | undefined;
}

export async function buildApp(config: ApiConfig, deps: AppDeps = {}) {
  const app = Fastify({
    loggerInstance: createLogger(config.logLevel),
    genReqId: (request) => request.headers['x-request-id']?.toString() ?? crypto.randomUUID(),
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(cors, {
    origin: config.webOrigins,
    credentials: true,
  });

  app.get(
    '/v1/health',
    {
      schema: {
        response: {
          200: HealthResponseSchema,
        },
      },
    },
    async () => ({
      service: 'api',
      status: 'ok' as const,
      version: '0.0.0',
      timestamp: new Date().toISOString(),
    }),
  );

  app.post(
    '/v1/system/ping',
    {
      schema: {
        response: {
          202: EnqueueSystemPingResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      if (!deps.systemJobs) {
        return reply
          .code(503)
          .send({ error: 'system job pipeline is not configured (DATABASE_URL and REDIS_URL required)' });
      }

      const { jobId } = await deps.systemJobs.enqueuePing();
      return reply.code(202).send({ jobId });
    },
  );

  app.get(
    '/v1/system/jobs/:id',
    {
      schema: {
        params: Type.Object({
          id: Type.String({ pattern: UUID_PATTERN }),
        }),
        response: {
          200: SystemJobSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.systemJobs) {
        return reply
          .code(503)
          .send({ error: 'system job pipeline is not configured (DATABASE_URL and REDIS_URL required)' });
      }

      const job = await deps.systemJobs.getJob(request.params.id);
      if (!job) {
        return reply.code(404).send({ error: 'system job not found' });
      }

      return job;
    },
  );

  return app;
}
