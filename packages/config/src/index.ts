export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export function readOptionalString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function readString(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  return readOptionalString(env, name) ?? fallback;
}

export function readOptionalBoolean(
  env: NodeJS.ProcessEnv,
  name: string,
): boolean | undefined {
  const value = readOptionalString(env, name);
  if (value === undefined) {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`Environment variable ${name} must be true or false`);
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

/**
 * Read a comma-separated list constrained to an allowed set of string literals.
 *
 * Returns a copy of `fallback` when the variable is unset/blank. Whitespace around
 * items is trimmed, blanks are dropped, duplicates are collapsed, and any value
 * outside `allowed` throws (a typo silently disabling a queue would be worse than
 * a hard failure at boot).
 */
export function readEnumList<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
  fallback: readonly T[],
): T[] {
  const value = readOptionalString(env, name);
  if (value === undefined) {
    return [...fallback];
  }
  const result: T[] = [];
  for (const raw of value.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    if (!allowed.includes(item as T)) {
      throw new Error(
        `Environment variable ${name} contains unknown value "${item}"; allowed values: ${allowed.join(', ')}`,
      );
    }
    if (!result.includes(item as T)) {
      result.push(item as T);
    }
  }
  return result;
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

/** A model endpoint (OpenAI-compatible chat completions) as read from the environment. */
export interface ModelEndpointConfig {
  baseUrl: string | undefined;
  apiKey: string | undefined;
  modelName: string | undefined;
}

export interface ResolvedModelEndpoint {
  baseUrl: string;
  apiKey: string;
  modelName: string;
}

/**
 * Resolve a per-feature model endpoint from the environment.
 *
 * Each of base URL / API key / model name is looked up under `<PREFIX>_MODEL_*`
 * for every prefix in order, then finally under the global `MODEL_*` vars. This
 * lets every AI feature be configured independently (its own endpoint, key and
 * model) while falling back to the shared defaults when nothing feature-specific
 * is set. Passing no prefix returns the global config verbatim.
 *
 * Variable names per prefix `FOO`:
 *   FOO_MODEL_API_BASE_URL / FOO_MODEL_API_KEY / FOO_MODEL_NAME
 * Global fallback:
 *   MODEL_API_BASE_URL / MODEL_API_KEY / MODEL_NAME
 */
export function readModelEndpoint(
  env: NodeJS.ProcessEnv,
  ...prefixes: string[]
): ModelEndpointConfig {
  const resolve = (suffix: string): string | undefined => {
    for (const prefix of prefixes) {
      const value = readOptionalString(env, `${prefix}_MODEL_${suffix}`);
      if (value) return value;
    }
    return readOptionalString(env, `MODEL_${suffix}`);
  };
  return {
    baseUrl: resolve('API_BASE_URL'),
    apiKey: resolve('API_KEY'),
    modelName: resolve('NAME'),
  };
}

/**
 * Narrow a {@link ModelEndpointConfig} to a fully-configured endpoint.
 *
 * Returns the resolved endpoint when all three fields are set, `undefined` when
 * none are set (caller should fall back to a fake engine), and throws when the
 * config is partial — a half-configured endpoint silently degrading to a fake
 * model would pass fake answers off as real.
 */
export function requireCompleteModelEndpoint(
  endpoint: ModelEndpointConfig,
  label: string,
): ResolvedModelEndpoint | undefined {
  const { baseUrl, apiKey, modelName } = endpoint;
  if (baseUrl && apiKey && modelName) {
    return { baseUrl, apiKey, modelName };
  }
  if (baseUrl || apiKey || modelName) {
    throw new Error(
      `partial model configuration for ${label}: API base URL, API key and model name must all be set (or none, to use the fake engine)`,
    );
  }
  return undefined;
}
