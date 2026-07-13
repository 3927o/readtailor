import { readInteger, readLogLevel, readOptionalString, readString } from '@readtailor/config';

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    host: readString(env, 'WORKER_HOST', '0.0.0.0'),
    port: readInteger(env, 'WORKER_PORT', 3002, { min: 1, max: 65_535 }),
    concurrency: readInteger(env, 'WORKER_CONCURRENCY', 1, { min: 1 }),
    redisUrl: readOptionalString(env, 'REDIS_URL'),
    logLevel: readLogLevel(env, 'LOG_LEVEL', 'info'),
  };
}
