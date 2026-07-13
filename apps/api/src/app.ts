import { Readable } from 'node:stream';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  type DependencyStatus,
  EnqueueSystemPingResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  SystemChatRequestSchema,
  SystemJobSchema,
} from '@readtailor/contracts';
import { createLogger } from '@readtailor/observability';
import type { ApiConfig } from './config';
import type { SystemChatEvent, SystemChatService } from './system-chat';
import type { SystemJobService } from './system-jobs';

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

// 冷启动首次探测要覆盖跨区 TLS 握手，超时给足 5 秒。
const HEALTH_PROBE_TIMEOUT_MS = 5000;

export type HealthProbe = () => Promise<void>;

export interface AppDeps {
  systemJobs?: SystemJobService | undefined;
  systemChat?: SystemChatService | undefined;
  healthProbes?: Record<string, HealthProbe> | undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`probe timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
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
          503: HealthResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const probes = Object.entries(deps.healthProbes ?? {});
      const dependencies: Record<string, DependencyStatus> = {};
      await Promise.all(
        probes.map(async ([name, probe]) => {
          try {
            await withTimeout(probe(), HEALTH_PROBE_TIMEOUT_MS);
            dependencies[name] = 'ok';
          } catch (error) {
            request.log.warn({ err: error, dependency: name }, 'health probe failed');
            dependencies[name] = 'error';
          }
        }),
      );

      const degraded = Object.values(dependencies).includes('error');
      if (degraded) {
        reply.code(503);
      }

      return {
        service: 'api',
        status: degraded ? ('degraded' as const) : ('ok' as const),
        version: '0.0.0',
        timestamp: new Date().toISOString(),
        ...(probes.length > 0 ? { dependencies } : {}),
      };
    },
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

  app.post(
    '/v1/system/chat',
    {
      // 响应是 SSE 流，不声明 response schema（流会绕过序列化，类型推导也不适用）。
      schema: {
        body: SystemChatRequestSchema,
      },
    },
    async (request, reply) => {
      const systemChat = deps.systemChat;
      if (!systemChat) {
        return reply
          .code(503)
          .send({ error: 'system chat is not configured (DATABASE_URL required)' });
      }

      const toSse = async function* (): AsyncGenerator<string> {
        try {
          for await (const event of systemChat.stream(request.body.prompt)) {
            yield `data: ${JSON.stringify(event satisfies SystemChatEvent)}\n\n`;
          }
        } catch (error) {
          // 响应头已经发出，只能用带内错误事件通知客户端。
          request.log.error({ err: error }, 'system chat stream failed');
          yield `data: ${JSON.stringify({ type: 'error', message: 'model stream failed' })}\n\n`;
        }
      };

      return reply
        .type('text/event-stream')
        .header('cache-control', 'no-cache')
        .send(Readable.from(toSse()));
    },
  );

  return app;
}
