import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { requireCompleteModelEndpoint } from '@readtailor/config';
import { createDatabase, systemJobs } from '@readtailor/database';
import { createFakeModelEngine, createOpenAiCompatibleEngine } from '@readtailor/model';
import { createLogger, createPerfSink } from '@readtailor/observability';
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
const perfSink = database ? createPerfSink({ db: database.db, logger }) : undefined;
if (perfSink) {
  app.addHook('onResponse', async (request, reply) => {
    perfSink.recordHttp({
      requestId: request.id,
      method: request.method,
      route: request.routeOptions?.url ?? request.url,
      statusCode: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime),
    });
  });
  app.addHook('onClose', async () => {
    await perfSink.close();
  });
}
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
const enabledQueues = new Set(config.queues);

if (config.redisUrl && !database) {
  logger.warn('DATABASE_URL not set: queue consumers disabled');
}

const queueWorker = config.redisUrl && database && enabledQueues.has('system')
  ? createSystemWorker({
      redisUrl: config.redisUrl,
      concurrency: config.systemConcurrency,
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

const normalizationModel = requireCompleteModelEndpoint(config.normalizationModel, 'normalization');
const analysisModel = requireCompleteModelEndpoint(config.analysisModel, 'book-analysis');
const normalizationSandbox = config.normalizationSandbox;
const normalizationConfigured = Boolean(
  config.redisUrl &&
    database &&
    objectStorage &&
    normalizationSandbox &&
    normalizationModel &&
    analysisModel,
);
// 消费队列前先回收上一个进程崩溃遗留的孤儿 run，避免书籍永远卡在处理中。
// 归属规范化池：只在启用了 normalization 队列的进程上对账，内容生成专用池不越俎代庖。
if (database && enabledQueues.has('normalization')) {
  await reconcileOrphanedNormalizationRuns({ db: database.db, logger }).catch((error: unknown) => {
    logger.error({ err: error }, 'failed to reconcile orphaned normalization runs');
  });
}

const normalizationWorker =
  normalizationConfigured &&
  enabledQueues.has('normalization') &&
  config.redisUrl &&
  database &&
  objectStorage &&
  normalizationSandbox &&
  normalizationModel &&
  analysisModel
    ? createNormalizationWorker({
        redisUrl: config.redisUrl,
        concurrency: config.normalizationConcurrency,
        logger,
        handler: async (job) => {
          await executeNormalizationRun({
            db: database.db,
            storage: objectStorage,
            normalizationRunId: job.data.runId,
            repoRoot,
            sandbox: normalizationSandbox,
            normalizationModel: normalizationModel!,
            analysisModel: analysisModel!,
            maxAttempts: config.normalizationMaxAttempts,
            maxTurns: config.normalizationMaxTurns,
            attemptTimeoutMs: config.normalizationAttemptTimeoutMs,
            analysisMaxTurns: config.analysisMaxTurns,
            analysisTimeoutMs: config.analysisTimeoutMs,
            logger,
            ...(perfSink ? { perfSink } : {}),
          });
        },
      })
    : undefined;

const contentGenerationEndpoint = requireCompleteModelEndpoint(
  config.contentGenerationModel,
  'content-generation',
);
const contentModel = contentGenerationEndpoint
  ? createOpenAiCompatibleEngine({
      baseUrl: contentGenerationEndpoint.baseUrl,
      apiKey: contentGenerationEndpoint.apiKey,
      model: contentGenerationEndpoint.modelName,
    })
  : createFakeModelEngine();
const contentGenerationWorker =
  config.redisUrl && database && objectStorage && enabledQueues.has('content-generation')
    ? createContentGenerationWorker({
        redisUrl: config.redisUrl,
        concurrency: config.contentGenerationConcurrency,
        logger,
        handler: async (job) => {
          await executeContentGeneration({
            db: database.db,
            storage: objectStorage,
            model: contentModel,
            generationId: job.data.generationId,
            ...(perfSink ? { perfSink } : {}),
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

// Only warn about missing dependencies for queues this process was actually asked to run;
// a queue left out of WORKER_QUEUES is disabled on purpose, not misconfigured.
if (enabledQueues.has('system') && !queueWorker) {
  logger.warn('system queue consumer disabled: Redis and database are required');
}
if (enabledQueues.has('normalization') && !normalizationWorker) {
  logger.warn(
    `normalization queue consumer disabled: Redis, database, object storage, ${config.sandboxProvider} sandbox and model configuration are required`,
  );
}
if (enabledQueues.has('content-generation') && !contentGenerationWorker) {
  logger.warn(
    'content generation queue consumer disabled: Redis, database and object storage are required',
  );
}

// Health/connection status follows whichever consumer this process runs (they share one Redis),
// so a content-generation-only pool still reports ready without the system queue.
const healthWorker = queueWorker ?? normalizationWorker ?? contentGenerationWorker;
let queueStatus: QueueStatus = !config.redisUrl
  ? 'not_configured'
  : !database
    ? 'dependency_missing'
    : healthWorker
      ? 'connecting'
      : 'not_configured';

logger.info(
  {
    enabledQueues: [...enabledQueues],
    active: {
      system: Boolean(queueWorker),
      normalization: Boolean(normalizationWorker),
      'content-generation': Boolean(contentGenerationWorker),
    },
  },
  'worker queue consumers initialized',
);

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
    logger.info('queue consumer connected');
  }
  queueStatus = 'connected';
};

healthWorker?.on('ready', () => {
  markQueueConnected();
});

healthWorker?.on('ioredis:close', () => {
  if (queueStatus !== 'disconnected') {
    logger.warn('queue consumer connection closed');
  }
  queueStatus = 'disconnected';
});

healthWorker?.on('error', (error) => {
  // 阻塞连接（取任务用）故障只会以 error 形式上抛，不会触发 ioredis:close；
  // 任一连接恢复后会重新收到 ready，届时状态会被拨回 connected。
  if (queueStatus !== 'disconnected') {
    logger.error({ err: error }, 'queue consumer error');
  }
  queueStatus = 'disconnected';
});

if (healthWorker) {
  void healthWorker.client
    .then((client) => {
      if (client.status === 'ready') {
        markQueueConnected();
      }
      client.on('ready', markQueueConnected);
    })
    .catch((error: unknown) => {
      logger.error({ err: error }, 'failed to observe queue consumer connection');
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
