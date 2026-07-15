import {
  readEnumList,
  readInteger,
  readLogLevel,
  readModelEndpoint,
  readOptionalString,
  readString,
} from '@readtailor/config';
import {
  NORMALIZATION_SANDBOX_PROVIDERS,
  type NormalizationSandboxConfig,
  type NormalizationSandboxProvider,
} from './normalization/sandbox';

// The queue consumers this worker binary knows how to run. A process starts a consumer only
// when its kind is selected via WORKER_QUEUES *and* its dependencies are configured — the two
// gates compose, so you can run dedicated pools (e.g. a content-generation-only fleet).
export const WORKER_QUEUE_KINDS = ['system', 'normalization', 'content-generation'] as const;
export type WorkerQueueKind = (typeof WORKER_QUEUE_KINDS)[number];

export type WorkerConfig = ReturnType<typeof loadWorkerConfig>;

export function loadNormalizationSandboxConfig(env: NodeJS.ProcessEnv = process.env): {
  provider: NormalizationSandboxProvider;
  sandbox: NormalizationSandboxConfig | undefined;
} {
  const rawProvider = readString(env, 'SANDBOX_PROVIDER', 'e2b');
  if (!NORMALIZATION_SANDBOX_PROVIDERS.includes(rawProvider as NormalizationSandboxProvider)) {
    throw new Error(
      `Environment variable SANDBOX_PROVIDER must be one of: ${NORMALIZATION_SANDBOX_PROVIDERS.join(', ')}`,
    );
  }
  const provider = rawProvider as NormalizationSandboxProvider;

  if (provider === 'ppio') {
    const apiKey = readOptionalString(env, 'PPIO_API_KEY');
    const template = readOptionalString(env, 'PPIO_TEMPLATE');
    return {
      provider,
      sandbox: apiKey
        ? {
            provider,
            apiKey,
            domain: readString(env, 'PPIO_DOMAIN', 'sandbox.ppio.cn'),
            ...(template ? { template } : {}),
          }
        : undefined,
    };
  }

  const apiKey = readOptionalString(env, 'E2B_API_KEY');
  const template = readOptionalString(env, 'E2B_TEMPLATE');
  return {
    provider,
    sandbox: apiKey
      ? {
          provider,
          apiKey,
          domain: readString(env, 'E2B_DOMAIN', 'e2b.dev'),
          ...(template ? { template } : {}),
        }
      : undefined,
  };
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env) {
  // WORKER_CONCURRENCY is the base default; each queue may override it independently so a
  // content-generation pool can fan out without also multiplying heavy normalization sandboxes.
  const concurrency = readInteger(env, 'WORKER_CONCURRENCY', 1, { min: 1 });
  const sandboxConfig = loadNormalizationSandboxConfig(env);
  return {
    host: readString(env, 'WORKER_HOST', '0.0.0.0'),
    port: readInteger(env, 'WORKER_PORT', 3002, { min: 1, max: 65_535 }),
    concurrency,
    systemConcurrency: readInteger(env, 'SYSTEM_CONCURRENCY', concurrency, { min: 1 }),
    normalizationConcurrency: readInteger(env, 'NORMALIZATION_CONCURRENCY', concurrency, { min: 1 }),
    // Content generation is lightweight LLM I/O, not a heavy normalization sandbox, so it defaults to 5 —
    // enough to run a trial's three segments in parallel with headroom — decoupled from the
    // conservative base so bumping it never fans out normalization. Safe now that the publish
    // path serializes with a row lock (tailoring/job.ts §6.3).
    contentGenerationConcurrency: readInteger(env, 'CONTENT_GENERATION_CONCURRENCY', 5, { min: 1 }),
    queues: readEnumList(env, 'WORKER_QUEUES', WORKER_QUEUE_KINDS, WORKER_QUEUE_KINDS),
    redisUrl: readOptionalString(env, 'REDIS_URL'),
    databaseUrl: readOptionalString(env, 'DATABASE_URL'),
    sandboxProvider: sandboxConfig.provider,
    normalizationSandbox: sandboxConfig.sandbox,
    // AI 功能各自可独立配置端点/key/模型，缺省回退到全局 MODEL_* 。
    // book-analysis 未单独配置时先继承 normalization，再回退全局，保持既有流水线行为。
    normalizationModel: readModelEndpoint(env, 'NORMALIZATION'),
    analysisModel: readModelEndpoint(env, 'BOOK_ANALYSIS', 'NORMALIZATION'),
    contentGenerationModel: readModelEndpoint(env, 'CONTENT_GENERATION'),
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
