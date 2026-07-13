import { readInteger, readLogLevel, readOptionalString, readString } from '@readtailor/config';

export type ApiConfig = ReturnType<typeof loadApiConfig>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    host: readString(env, 'API_HOST', '0.0.0.0'),
    databaseUrl: readOptionalString(env, 'DATABASE_URL'),
    redisUrl: readOptionalString(env, 'REDIS_URL'),
    objectStorageLocalRoot: readOptionalString(env, 'OBJECT_STORAGE_LOCAL_ROOT'),
    objectStorageEndpoint: readOptionalString(env, 'OBJECT_STORAGE_ENDPOINT'),
    objectStorageRegion: readOptionalString(env, 'OBJECT_STORAGE_REGION'),
    objectStorageBucket: readOptionalString(env, 'OBJECT_STORAGE_BUCKET'),
    objectStorageAccessKeyId: readOptionalString(env, 'OBJECT_STORAGE_ACCESS_KEY_ID'),
    objectStorageSecretAccessKey: readOptionalString(env, 'OBJECT_STORAGE_SECRET_ACCESS_KEY'),
    modelBaseUrl: readOptionalString(env, 'MODEL_API_BASE_URL'),
    modelApiKey: readOptionalString(env, 'MODEL_API_KEY'),
    modelName: readOptionalString(env, 'MODEL_NAME'),
    port: readInteger(env, 'API_PORT', 3001, { min: 1, max: 65_535 }),
    webOrigins: readString(
      env,
      'WEB_ORIGINS',
      'http://localhost:5173,http://127.0.0.1:5173',
    )
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    logLevel: readLogLevel(env, 'LOG_LEVEL', 'info'),
  };
}
