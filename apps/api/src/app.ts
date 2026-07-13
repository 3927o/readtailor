import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { HealthResponseSchema } from '@readtailor/contracts';
import { createLogger } from '@readtailor/observability';
import type { ApiConfig } from './config';

export async function buildApp(config: ApiConfig) {
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

  return app;
}
