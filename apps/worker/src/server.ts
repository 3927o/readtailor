import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, systemJobs } from '@readtailor/database';
import { createFakeModelEngine, createOpenAiCompatibleEngine } from '@readtailor/model';
import { createLogger } from '@readtailor/observability';
import {
  createContentGenerationWorker,
  createNormalizationWorker,
  createSystemWorker,
} from '@readtailor/queue';
import { createObjectStorage } from '@readtailor/storage';
import { loadWorkerConfig } from './config';
import { executeNormalizationRun } from './normalization/job';
import { reconcileOrphanedNormalizationRuns } from './normalization/reconcile';
import { executeContentGeneration, failContentGeneration } from './tailoring/job';

const config = loadWorkerConfig();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const logger = createLogger(config.logLevel);
const app = Fastify({ loggerInstance: logger });

const database = config.databaseUrl ? createDatabase(config.databaseUrl) : undefined;
const objectStorage = createObjectStorage({
  localRoot: config.objectStorageLocalRoot
    ? resolve(repoRoot, config.objectStorageLocalRoot)
    : undefined,
  endpoint: config.objectStorageEndpoint,
  region: config.objectStorageRegion,
  bucket: config.objectStorageBucket,
  accessKeyId: config.objectStorageAccessKeyId,
  secretAccessKey: config.objectStorageSecretAccessKey,
});

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
        if (!job.data.jobId) {
          // 旧格式任务没有 jobId；undefined 传给 postgres.js 会直接抛 UNDEFINED_VALUE。
          logger.warn({ queueJobId: job.id }, 'skipping legacy job without jobId');
          return;
        }
        await database.db
          .update(systemJobs)
          // created_at 由数据库时钟生成，完成时间也用 now() 以免本机时钟偏差造成先完成后创建。
          .set({ status: 'completed', completedAt: sql`now()` })
          .where(eq(systemJobs.id, job.data.jobId));
      },
    })
  : undefined;

const normalizationModel = config.normalizationModelName ?? config.modelName;
const analysisModel = config.analysisModelName ?? normalizationModel;
const normalizationConfigured = Boolean(
  config.redisUrl &&
    database &&
    objectStorage &&
    config.e2bApiKey &&
    config.modelApiBaseUrl &&
    config.modelApiKey &&
    normalizationModel &&
    analysisModel,
);
// 消费队列前先回收上一个进程崩溃遗留的孤儿 run，避免书籍永远卡在处理中。
if (database) {
  await reconcileOrphanedNormalizationRuns({ db: database.db, logger }).catch((error: unknown) => {
    logger.error({ err: error }, 'failed to reconcile orphaned normalization runs');
  });
}

const normalizationWorker =
  normalizationConfigured &&
  config.redisUrl &&
  database &&
  objectStorage &&
  config.e2bApiKey &&
  config.modelApiBaseUrl &&
  config.modelApiKey &&
  normalizationModel &&
  analysisModel
    ? createNormalizationWorker({
        redisUrl: config.redisUrl,
        concurrency: config.concurrency,
        logger,
        handler: async (job) => {
          await executeNormalizationRun({
            db: database.db,
            storage: objectStorage,
            normalizationRunId: job.data.runId,
            repoRoot,
            e2bApiKey: config.e2bApiKey!,
            ...(config.e2bTemplate ? { e2bTemplate: config.e2bTemplate } : {}),
            modelApiBaseUrl: config.modelApiBaseUrl!,
            modelApiKey: config.modelApiKey!,
            normalizationModel,
            analysisModel,
            maxAttempts: config.normalizationMaxAttempts,
            maxTurns: config.normalizationMaxTurns,
            attemptTimeoutMs: config.normalizationAttemptTimeoutMs,
            analysisMaxTurns: config.analysisMaxTurns,
            analysisTimeoutMs: config.analysisTimeoutMs,
            logger,
          });
        },
      })
    : undefined;

const modelVars = [config.modelApiBaseUrl, config.modelApiKey, config.modelName];
if (modelVars.some(Boolean) && !modelVars.every(Boolean)) {
  throw new Error(
    'partial model configuration: MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_NAME must all be set (or none, to use the fake engine)',
  );
}
const contentModel =
  config.modelApiBaseUrl && config.modelApiKey && config.modelName
    ? createOpenAiCompatibleEngine({
        baseUrl: config.modelApiBaseUrl,
        apiKey: config.modelApiKey,
        model: config.modelName,
      })
    : createFakeModelEngine();
const contentGenerationWorker =
  config.redisUrl && database && objectStorage
    ? createContentGenerationWorker({
        redisUrl: config.redisUrl,
        concurrency: config.concurrency,
        logger,
        handler: async (job) => {
          await executeContentGeneration({
            db: database.db,
            storage: objectStorage,
            model: contentModel,
            generationId: job.data.generationId,
          });
        },
        onTerminalFailure: async (job, error) => {
          await failContentGeneration({
            db: database.db,
            generationId: job.data.generationId,
            error,
          });
        },
      })
    : undefined;

if (!normalizationWorker) {
  logger.warn(
    'normalization queue consumer disabled: Redis, database, object storage, E2B and model configuration are required',
  );
}
if (!contentGenerationWorker) {
  logger.warn(
    'content generation queue consumer disabled: Redis, database and object storage are required',
  );
}

queueWorker?.on('failed', (job, error) => {
  if (!database || !job || !job.data.jobId) {
    return;
  }
  const attempts = job.opts.attempts ?? 1;
  // UnrecoverableError（含 stall 淘汰路径）在 attemptsMade < attempts 时就已终态失败。
  const terminal = job.attemptsMade >= attempts || error.name === 'UnrecoverableError';
  if (!terminal) {
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
  // 阻塞连接（取任务用）故障只会以 error 形式上抛，不会触发 ioredis:close；
  // 任一连接恢复后会重新收到 ready，届时状态会被拨回 connected。
  if (queueStatus !== 'disconnected') {
    logger.error({ err: error }, 'system queue error');
  }
  queueStatus = 'disconnected';
});

if (queueWorker) {
  void queueWorker.client
    .then((client) => {
      if (client.status === 'ready') {
        markQueueConnected();
      }
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
  // 兜底：清理流程若被卡住（如长任务不结束），限时后强制退出，避免只能被 SIGKILL。
  setTimeout(() => process.exit(1), 10_000).unref();
  await queueWorker?.close();
  await normalizationWorker?.close();
  await contentGenerationWorker?.close();
  await app.close();
  await database?.client.end({ timeout: 5 });
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
