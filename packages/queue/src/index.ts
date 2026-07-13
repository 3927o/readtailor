import { Queue, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import IORedis from 'ioredis';
import type { Logger } from 'pino';
import type { SystemJobPayload } from '@readtailor/contracts';

export const SYSTEM_QUEUE_NAME = 'system';

function createRedis(redisUrl: string) {
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export function createSystemQueue(redisUrl: string) {
  return new Queue<SystemJobPayload>(SYSTEM_QUEUE_NAME, {
    connection: createRedis(redisUrl),
    defaultJobOptions: {
      attempts: 3,
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });
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
      connection: createRedis(options.redisUrl),
      concurrency: options.concurrency,
    },
  );

  worker.on('failed', (job, error) => {
    options.logger.error({ err: error, jobId: job?.id }, 'system job failed');
  });

  return worker;
}
