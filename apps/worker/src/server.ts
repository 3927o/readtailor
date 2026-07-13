import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { createDatabase, systemJobs } from '@readtailor/database';
import { createLogger } from '@readtailor/observability';
import { createSystemWorker } from '@readtailor/queue';
import { loadWorkerConfig } from './config';

const config = loadWorkerConfig();
const logger = createLogger(config.logLevel);
const app = Fastify({ loggerInstance: logger });

const database = config.databaseUrl ? createDatabase(config.databaseUrl) : undefined;

type QueueStatus =
  | 'not_configured'
  | 'dependency_missing'
  | 'connecting'
  | 'connected'
  | 'disconnected';
let queueStatus: QueueStatus = config.redisUrl
  ? database
    ? 'connecting'
    : 'dependency_missing'
  : 'not_configured';

if (config.redisUrl && !database) {
  logger.warn('DATABASE_URL not set: system queue consumer disabled');
}

const queueWorker = config.redisUrl && database
  ? createSystemWorker({
      redisUrl: config.redisUrl,
      concurrency: config.concurrency,
      logger,
      handler: async (job) => {
        await database.db
          .update(systemJobs)
          .set({ status: 'completed', completedAt: new Date() })
          .where(eq(systemJobs.id, job.data.jobId));
      },
    })
  : undefined;

queueWorker?.on('failed', (job) => {
  if (!database || !job) {
    return;
  }
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < attempts) {
    return; // BullMQ 还会重试，先不落失败状态
  }
  void database.db
    .update(systemJobs)
    .set({ status: 'failed' })
    .where(eq(systemJobs.id, job.data.jobId))
    .catch((error: unknown) => {
      logger.error({ err: error, jobId: job.data.jobId }, 'failed to mark system job as failed');
    });
});

const markQueueConnected = () => {
  if (queueStatus !== 'connected') {
    logger.info('system queue connected');
  }
  queueStatus = 'connected';
};

queueWorker?.on('ready', () => {
  markQueueConnected();
});

queueWorker?.on('ioredis:close', () => {
  if (queueStatus !== 'disconnected') {
    logger.warn('system queue connection closed');
  }
  queueStatus = 'disconnected';
});

queueWorker?.on('error', (error) => {
  logger.error({ err: error }, 'system queue error');
});

if (queueWorker) {
  void queueWorker.client
    .then((client) => {
      client.on('ready', markQueueConnected);
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'failed to observe system queue connection');
    });
}

const probeDatabase = async (): Promise<'ok' | 'error' | 'not_configured'> => {
  if (!database) {
    return 'not_configured';
  }
  try {
    await Promise.race([
      database.client`select 1`,
      new Promise((_resolve, reject) =>
        // 冷启动首次探测要覆盖跨区 TLS 握手，超时给足 5 秒。
        setTimeout(() => reject(new Error('database probe timed out')), 5000),
      ),
    ]);
    return 'ok';
  } catch (error) {
    logger.warn({ err: error }, 'database health probe failed');
    return 'error';
  }
};

app.get('/health', async (_request, reply) => {
  const databaseStatus = await probeDatabase();
  const ready = queueStatus === 'connected' && databaseStatus === 'ok';
  if (!ready) {
    reply.code(503);
  }

  return {
    service: 'worker',
    status: ready ? ('ok' as const) : ('degraded' as const),
    queue: queueStatus,
    database: databaseStatus,
    version: '0.0.0',
    timestamp: new Date().toISOString(),
  };
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down worker');
  await queueWorker?.close();
  await app.close();
  await database?.client.end({ timeout: 5 });
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
