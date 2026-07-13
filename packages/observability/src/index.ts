import type { LogLevel } from '@readtailor/config';
import pino, { type Logger } from 'pino';

export function createLogger(level: LogLevel = 'info'): Logger {
  return pino({
    level,
    base: null,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.accessToken', '*.refreshToken'],
      censor: '[redacted]',
    },
  });
}
