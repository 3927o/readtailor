import Fastify from 'fastify';
import { createLogger } from '@readtailor/observability';
import { createSystemWorker } from '@readtailor/queue';
import { loadWorkerConfig } from './config';

const config = loadWorkerConfig();
const logger = createLogger(config.logLevel);
const app = Fastify({ loggerInstance: logger });

const queueWorker = config.redisUrl
  ? createSystemWorker({
      redisUrl: config.redisUrl,
      concurrency: config.concurrency,
      logger,
    })
  : undefined;

app.get('/health', async () => ({
  service: 'worker',
  status: queueWorker ? 'ok' : 'degraded',
  queue: queueWorker ? 'connected' : 'not_configured',
  version: '0.0.0',
  timestamp: new Date().toISOString(),
}));

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down worker');
  await queueWorker?.close();
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
