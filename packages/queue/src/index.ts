import { Queue, Worker } from 'bullmq';
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

export function createSystemWorker(options: {
  redisUrl: string;
  concurrency: number;
  logger: Logger;
}) {
  const worker = new Worker<SystemJobPayload>(
    SYSTEM_QUEUE_NAME,
    async (job) => {
      options.logger.info({ jobId: job.id, kind: job.data.kind }, 'processing system job');
      return {
        receivedAt: new Date().toISOString(),
      };
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
