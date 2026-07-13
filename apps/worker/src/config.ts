import { readLogLevel, readNumber, readOptionalString, readString } from '@readtailor/config';

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    host: readString(env, 'WORKER_HOST', '0.0.0.0'),
    port: readNumber(env, 'WORKER_PORT', 3002),
    concurrency: readNumber(env, 'WORKER_CONCURRENCY', 1),
    redisUrl: readOptionalString(env, 'REDIS_URL'),
    logLevel: readLogLevel(env, 'LOG_LEVEL', 'info'),
  };
}
