import { Queue, Worker } from 'bullmq';
import type { Job, RedisOptions } from 'bullmq';
import type IORedis from 'ioredis';
import type { Logger } from 'pino';
import type { NormalizationJobPayload, SystemJobPayload } from '@readtailor/contracts';

export const SYSTEM_QUEUE_NAME = 'system';
export const NORMALIZATION_QUEUE_NAME = 'normalization';

// 传连接参数而非 ioredis 实例：实例会被 BullMQ 视作调用方所有（shared），
// close() 时不 quit，socket 只能靠进程退出回收。
function redisOptionsFromUrl(redisUrl: string): RedisOptions {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(url.pathname && url.pathname !== '/' ? { db: Number(url.pathname.slice(1)) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
}

export function createSystemQueue(redisUrl: string) {
  return new Queue<SystemJobPayload>(SYSTEM_QUEUE_NAME, {
    connection: redisOptionsFromUrl(redisUrl),
    defaultJobOptions: {
      attempts: 3,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });
}

export function createNormalizationQueue(redisUrl: string) {
  return new Queue<NormalizationJobPayload>(NORMALIZATION_QUEUE_NAME, {
    connection: redisOptionsFromUrl(redisUrl),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });
}

export type NormalizationQueue = ReturnType<typeof createNormalizationQueue>;
export type NormalizationQueueJob = Job<NormalizationJobPayload>;

export function createNormalizationWorker(options: {
  redisUrl: string;
  concurrency: number;
  logger: Logger;
  handler: (job: NormalizationQueueJob) => Promise<void>;
}) {
  const worker = new Worker<NormalizationJobPayload>(
    NORMALIZATION_QUEUE_NAME,
    async (job) => {
      options.logger.info({ jobId: job.id, runId: job.data.runId }, 'processing normalization job');
      await options.handler(job);
    },
    {
      connection: redisOptionsFromUrl(options.redisUrl),
      concurrency: options.concurrency,
    },
  );

  worker.on('failed', (job, error) => {
    options.logger.error(
      { err: error, jobId: job?.id, runId: job?.data.runId },
      'normalization job failed',
    );
  });

  return worker;
}

export type SystemQueue = ReturnType<typeof createSystemQueue>;
export type SystemQueueJob = Job<SystemJobPayload>;

export async function pingSystemQueue(queue: SystemQueue): Promise<void> {
  // BullMQ 把 client 类型收窄成了不含 ping 的最小接口，这里的连接实际是 ioredis 实例。
  const client = (await queue.client) as unknown as IORedis;
  await client.ping();
}

export function createSystemWorker(options: {
  redisUrl: string;
  concurrency: number;
  logger: Logger;
  handler: (job: SystemQueueJob) => Promise<void>;
}) {
  const worker = new Worker<SystemJobPayload>(
    SYSTEM_QUEUE_NAME,
    async (job) => {
      options.logger.info({ jobId: job.id, kind: job.data.kind }, 'processing system job');
      await options.handler(job);
    },
    {
      connection: redisOptionsFromUrl(options.redisUrl),
      concurrency: options.concurrency,
    },
  );

  worker.on('failed', (job, error) => {
    options.logger.error({ err: error, jobId: job?.id }, 'system job failed');
  });

  return worker;
}
