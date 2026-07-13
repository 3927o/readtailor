export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function readOptionalString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function readString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return readOptionalString(env, name) ?? fallback;
}

export function requireString(env: NodeJS.ProcessEnv, name: string): string {
  const value = readOptionalString(env, name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = readOptionalString(env, name);
  if (!value) {
    return fallback;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Environment variable ${name} must be a finite number`);
  }
  return number;
}

export function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const number = readNumber(env, name, fallback);
  if (!Number.isInteger(number)) {
    throw new Error(`Environment variable ${name} must be an integer`);
  }
  if (options.min !== undefined && number < options.min) {
    throw new Error(`Environment variable ${name} must be at least ${options.min}`);
  }
  if (options.max !== undefined && number > options.max) {
    throw new Error(`Environment variable ${name} must be at most ${options.max}`);
  }
  return number;
}

export function readLogLevel(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: LogLevel,
): LogLevel {
  const value = readOptionalString(env, name) ?? fallback;
  if (!LOG_LEVELS.includes(value as LogLevel)) {
    throw new Error(`Environment variable ${name} must be a valid log level`);
  }
  return value as LogLevel;
}
