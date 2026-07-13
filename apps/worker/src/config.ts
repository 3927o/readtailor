import { readInteger, readLogLevel, readOptionalString, readString } from '@readtailor/config';

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    host: readString(env, 'WORKER_HOST', '0.0.0.0'),
    port: readInteger(env, 'WORKER_PORT', 3002, { min: 1, max: 65_535 }),
    concurrency: readInteger(env, 'WORKER_CONCURRENCY', 1, { min: 1 }),
    redisUrl: readOptionalString(env, 'REDIS_URL'),
    databaseUrl: readOptionalString(env, 'DATABASE_URL'),
    e2bApiKey: readOptionalString(env, 'E2B_API_KEY'),
    e2bTemplate: readOptionalString(env, 'E2B_TEMPLATE'),
    modelApiBaseUrl: readOptionalString(env, 'MODEL_API_BASE_URL'),
    modelApiKey: readOptionalString(env, 'MODEL_API_KEY'),
    modelName: readOptionalString(env, 'MODEL_NAME'),
    normalizationModelName: readOptionalString(env, 'NORMALIZATION_MODEL_NAME'),
    analysisModelName: readOptionalString(env, 'BOOK_ANALYSIS_MODEL_NAME'),
    objectStorageLocalRoot: readOptionalString(env, 'OBJECT_STORAGE_LOCAL_ROOT'),
    objectStorageEndpoint: readOptionalString(env, 'OBJECT_STORAGE_ENDPOINT'),
    objectStorageRegion: readOptionalString(env, 'OBJECT_STORAGE_REGION'),
    objectStorageBucket: readOptionalString(env, 'OBJECT_STORAGE_BUCKET'),
    objectStorageAccessKeyId: readOptionalString(env, 'OBJECT_STORAGE_ACCESS_KEY_ID'),
    objectStorageSecretAccessKey: readOptionalString(env, 'OBJECT_STORAGE_SECRET_ACCESS_KEY'),
    normalizationMaxAttempts: readInteger(env, 'NORMALIZATION_MAX_ATTEMPTS', 3, { min: 1 }),
    normalizationMaxTurns: readInteger(env, 'NORMALIZATION_MAX_TURNS', 50, { min: 1 }),
    normalizationAttemptTimeoutMs: readInteger(
      env,
      'NORMALIZATION_ATTEMPT_TIMEOUT_MS',
      30 * 60_000,
      { min: 60_000 },
    ),
    analysisMaxTurns: readInteger(env, 'BOOK_ANALYSIS_MAX_TURNS', 20, { min: 1 }),
    analysisTimeoutMs: readInteger(env, 'BOOK_ANALYSIS_TIMEOUT_MS', 20 * 60_000, {
      min: 60_000,
    }),
    logLevel: readLogLevel(env, 'LOG_LEVEL', 'info'),
  };
}
