import Fastify from 'fastify';
import { createLogger } from '@readtailor/observability';
import { createSystemWorker } from '@readtailor/queue';
import { loadWorkerConfig } from './config';

const config = loadWorkerConfig();
const logger = createLogger(config.logLevel);
const app = Fastify({ loggerInstance: logger });

type QueueStatus = 'not_configured' | 'connecting' | 'connected' | 'disconnected';
let queueStatus: QueueStatus = config.redisUrl ? 'connecting' : 'not_configured';

const queueWorker = config.redisUrl
  ? createSystemWorker({
      redisUrl: config.redisUrl,
      concurrency: config.concurrency,
      logger,
    })
  : undefined;

queueWorker?.on('ready', () => {
  queueStatus = 'connected';
  logger.info('system queue connected');
});

queueWorker?.on('ioredis:close', () => {
  if (queueStatus !== 'disconnected') {
    logger.warn('system queue connection closed');
  }
  queueStatus = 'disconnected';
});

queueWorker?.on('error', (error) => {
  if (queueStatus !== 'disconnected') {
    logger.error({ err: error }, 'system queue error');
  }
  queueStatus = 'disconnected';
});

app.get('/health', async (_request, reply) => {
  const ready = queueStatus === 'connected';
  if (!ready) {
    reply.code(503);
  }

  return {
    service: 'worker',
    status: ready ? ('ok' as const) : ('degraded' as const),
    queue: queueStatus,
    version: '0.0.0',
    timestamp: new Date().toISOString(),
  };
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down worker');
  await queueWorker?.close();
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
