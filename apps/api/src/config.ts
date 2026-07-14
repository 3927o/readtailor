import {
  readInteger,
  readLogLevel,
  readModelEndpoint,
  readOptionalString,
  readString,
} from '@readtailor/config';

export type ApiConfig = ReturnType<typeof loadApiConfig>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env) {
  const production = env.NODE_ENV === 'production';
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
    // AI 功能各自可独立配置端点/key/模型，缺省回退到全局 MODEL_* 。
    systemChatModel: readModelEndpoint(env, 'SYSTEM_CHAT'),
    readingSetupModel: readModelEndpoint(env, 'READING_SETUP'),
    authCookieSecret: readOptionalString(env, 'AUTH_COOKIE_SECRET'),
    authCookieSecure: (readOptionalString(env, 'AUTH_COOKIE_SECURE') ?? String(production)) === 'true',
    authSessionDays: readInteger(env, 'AUTH_SESSION_DAYS', 30, { min: 1, max: 365 }),
    authDevelopmentEnabled: readOptionalString(env, 'AUTH_DEVELOPMENT_ENABLED') === 'true',
    googleClientId: readOptionalString(env, 'GOOGLE_CLIENT_ID'),
    googleClientSecret: readOptionalString(env, 'GOOGLE_CLIENT_SECRET'),
    googleRedirectUri: readString(
      env,
      'GOOGLE_REDIRECT_URI',
      'http://localhost:3001/v1/auth/google/callback',
    ),
    webBaseUrl: readString(env, 'WEB_BASE_URL', 'http://localhost:5173'),
    systemApiToken: readOptionalString(env, 'SYSTEM_API_TOKEN'),
    port: readInteger(env, 'API_PORT', 3001, { min: 1, max: 65_535 }),
    webOrigins: readString(
      env,
      'WEB_ORIGINS',
      'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174',
    )
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    logLevel: readLogLevel(env, 'LOG_LEVEL', 'info'),
  };
}
