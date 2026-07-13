import { Readable } from 'node:stream';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify from 'fastify';
import { Type } from '@sinclair/typebox';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import {
  type DependencyStatus,
  BookCatalogResponseSchema,
  BookNormalizationStatusSchema,
  EnqueueSystemPingResponseSchema,
  ErrorResponseSchema,
  HealthResponseSchema,
  ImportBookResponseSchema,
  SharedBookSchema,
  SystemChatRequestSchema,
  SystemJobSchema,
} from '@readtailor/contracts';
import { createLogger } from '@readtailor/observability';
import type { ApiConfig } from './config';
import { BookImportError, type BookImportService } from './book-imports';
import type { BookService } from './books';
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
  books?: BookService | undefined;
  bookImports?: BookImportService | undefined;
}

const bookIdParams = Type.Object({
  id: Type.String({ pattern: UUID_PATTERN }),
});

function assetContentType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  return (
    {
      avif: 'image/avif',
      gif: 'image/gif',
      jpeg: 'image/jpeg',
      jpg: 'image/jpeg',
      png: 'image/png',
      svg: 'image/svg+xml',
      webp: 'image/webp',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      ogg: 'audio/ogg',
      webm: 'video/webm',
      woff: 'font/woff',
      woff2: 'font/woff2',
    }[extension ?? ''] ?? 'application/octet-stream'
  );
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
  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: 100 * 1024 * 1024,
    },
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
    '/v1/books',
    {
      schema: {
        response: {
          200: BookCatalogResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (_request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      return { books: await deps.books.listBooks() };
    },
  );

  app.post(
    '/v1/books/import',
    {
      schema: {
        response: {
          200: ImportBookResponseSchema,
          202: ImportBookResponseSchema,
          400: ErrorResponseSchema,
          413: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.bookImports) {
        return reply.code(503).send({ error: 'book import pipeline is not configured' });
      }
      try {
        const upload = await request.file();
        if (!upload) return reply.code(400).send({ error: '请选择 EPUB 文件' });
        const result = await deps.bookImports.importBook({
          filename: upload.filename,
          mediaType: upload.mimetype,
          bytes: await upload.toBuffer(),
        });
        return reply.code(result.reused ? 200 : 202).send(result);
      } catch (error) {
        if (error instanceof BookImportError) {
          return reply.code(error.statusCode === 413 ? 413 : 400).send({ error: error.message });
        }
        if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
          return reply.code(413).send({ error: 'EPUB 文件不能超过 100 MB' });
        }
        throw error;
      }
    },
  );

  app.get(
    '/v1/books/:id/status',
    {
      schema: {
        params: bookIdParams,
        response: {
          200: BookNormalizationStatusSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      const status = await deps.books.getNormalizationStatus(request.params.id);
      return status ?? reply.code(404).send({ error: 'book not found' });
    },
  );

  app.get(
    '/v1/books/:id',
    {
      schema: {
        params: bookIdParams,
        response: {
          200: SharedBookSchema,
          404: ErrorResponseSchema,
          503: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      const book = await deps.books.getBook(request.params.id);
      return book ?? reply.code(404).send({ error: 'ready book not found' });
    },
  );

  app.get(
    '/v1/books/:id/manifest',
    { schema: { params: bookIdParams } },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      const manifest = await deps.books.getManifest(request.params.id);
      return manifest ?? reply.code(404).send({ error: 'book manifest not found' });
    },
  );

  app.get(
    '/v1/books/:id/content',
    { schema: { params: bookIdParams } },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      const content = await deps.books.getContent(request.params.id);
      if (!content) {
        return reply.code(404).send({ error: 'book content not found' });
      }
      return reply.type('text/html; charset=utf-8').send(Buffer.from(content));
    },
  );

  app.get(
    '/v1/books/:id/profile',
    { schema: { params: bookIdParams } },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      const profile = await deps.books.getProfile(request.params.id);
      return profile ?? reply.code(404).send({ error: 'book profile not found' });
    },
  );

  app.get(
    '/v1/books/:id/assets/*',
    {
      schema: {
        params: Type.Object({
          id: Type.String({ pattern: UUID_PATTERN }),
          '*': Type.String({ minLength: 1 }),
        }),
      },
    },
    async (request, reply) => {
      if (!deps.books) {
        return reply.code(503).send({ error: 'book catalog is not configured' });
      }
      const path = request.params['*'];
      const asset = await deps.books.getAsset(request.params.id, path);
      if (!asset) {
        return reply.code(404).send({ error: 'book asset not found' });
      }
      reply.header('x-content-type-options', 'nosniff');
      if (path.toLowerCase().endsWith('.svg')) {
        reply.header(
          'content-security-policy',
          "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        );
      }
      return reply.type(assetContentType(path)).send(Buffer.from(asset));
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

      const encode = (event: SystemChatEvent) => `data: ${JSON.stringify(event)}\n\n`;

      // 先拉取首个事件再开流：开流前的失败（如数据库不可用）还能以 HTTP 错误码呈现，
      // 一旦响应头发出就只能靠带内 error 事件了。
      const events = systemChat.stream(request.body.prompt);
      let first: IteratorResult<SystemChatEvent>;
      try {
        first = await events.next();
      } catch (error) {
        request.log.error({ err: error }, 'system chat failed to start');
        return reply.code(500).send({ error: 'system chat failed to start' });
      }

      const toSse = async function* (): AsyncGenerator<string> {
        try {
          if (!first.done) {
            yield encode(first.value);
          }
          for await (const event of events) {
            yield encode(event);
          }
        } catch (error) {
          request.log.error({ err: error }, 'system chat stream failed');
          yield encode({ type: 'error', message: 'model stream failed' });
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
