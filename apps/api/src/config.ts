import { readInteger, readLogLevel, readString } from '@readtailor/config';

export type ApiConfig = ReturnType<typeof loadApiConfig>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    host: readString(env, 'API_HOST', '0.0.0.0'),
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
