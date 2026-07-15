import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireCompleteModelEndpoint } from '@readtailor/config';
import { createDatabase } from '@readtailor/database';
import { createFakeModelEngine, createOpenAiCompatibleEngine } from '@readtailor/model';
import { createLogger, createPerfSink } from '@readtailor/observability';
import {
  createContentGenerationQueue,
  createNormalizationQueue,
  createSystemQueue,
  pingSystemQueue,
} from '@readtailor/queue';
import { createObjectStorage } from '@readtailor/storage';
import { buildApp } from './app';
import { createAuthService } from './auth';
import { createBookImportService } from './book-imports';
import { createBookService, createDatabaseBookRepository } from './books';
import { loadApiConfig } from './config';
import { createProfileService } from './profiles';
import { createSystemChatService } from './system-chat';
import { createSystemJobService } from './system-jobs';
import {
  createAgentReadingSetupEngine,
  createFakeReadingSetupEngine,
} from './reading-setup-engine';
import { createAgentAskAiEngine } from './ask-ai-engine';
import { createUserBookService } from './user-books';

const config = loadApiConfig();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const database = config.databaseUrl ? createDatabase(config.databaseUrl) : undefined;
const logger = createLogger(config.logLevel);
const perfSink = database ? createPerfSink({ db: database.db, logger }) : undefined;
const googleVars = [config.googleClientId, config.googleClientSecret];
if (googleVars.some(Boolean) && !googleVars.every(Boolean)) {
  throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be configured');
}
const auth = database && config.authCookieSecret
  ? createAuthService({
      db: database.db,
      oauthStateSecret: config.authCookieSecret,
      developmentLoginEnabled: config.authDevelopmentEnabled,
      sessionTtlMs: config.authSessionDays * 24 * 60 * 60 * 1000,
      ...(config.googleClientId && config.googleClientSecret
        ? {
            google: {
              clientId: config.googleClientId,
              clientSecret: config.googleClientSecret,
              redirectUri: config.googleRedirectUri,
            },
          }
        : {}),
    })
  : undefined;
const profiles = database ? createProfileService({ db: database.db }) : undefined;
const systemQueue = config.redisUrl ? createSystemQueue(config.redisUrl) : undefined;
const normalizationQueue = config.redisUrl ? createNormalizationQueue(config.redisUrl) : undefined;
const contentGenerationQueue = config.redisUrl
  ? createContentGenerationQueue(config.redisUrl)
  : undefined;
const objectStorage = createObjectStorage({
  localRoot: config.objectStorageLocalRoot
    ? resolve(repoRoot, config.objectStorageLocalRoot)
    : undefined,
  bucket: config.objectStorageBucket,
  endpoint: config.objectStorageEndpoint,
  region: config.objectStorageRegion,
  accessKeyId: config.objectStorageAccessKeyId,
  secretAccessKey: config.objectStorageSecretAccessKey,
});
const systemJobs =
  database && systemQueue
    ? createSystemJobService({ db: database.db, queue: systemQueue })
    : undefined;

// 配置残缺时静默落到假模型会把假回声当成功答复端给用户，requireCompleteModelEndpoint 会抛错。
const systemChatEndpoint = requireCompleteModelEndpoint(config.systemChatModel, 'system-chat');
const modelEngine = systemChatEndpoint
  ? createOpenAiCompatibleEngine({
      baseUrl: systemChatEndpoint.baseUrl,
      apiKey: systemChatEndpoint.apiKey,
      model: systemChatEndpoint.modelName,
    })
  : createFakeModelEngine();

const systemChat = database
  ? createSystemChatService({
      db: database.db,
      engine: modelEngine,
      ...(perfSink ? { perfSink } : {}),
    })
  : undefined;
const books =
  database && objectStorage
    ? createBookService({
        repository: createDatabaseBookRepository(database.db),
        storage: objectStorage,
      })
    : undefined;
const bookImports =
  database && objectStorage && normalizationQueue
    ? createBookImportService({
        db: database.db,
        storage: objectStorage,
        queue: normalizationQueue,
      })
    : undefined;
const readingSetupEndpoint = requireCompleteModelEndpoint(
  config.readingSetupModel,
  'reading-setup',
);
const readingSetupEngine = readingSetupEndpoint
  ? createAgentReadingSetupEngine({
      apiBaseUrl: readingSetupEndpoint.baseUrl,
      apiKey: readingSetupEndpoint.apiKey,
      modelName: readingSetupEndpoint.modelName,
      ...(perfSink ? { perfSink } : {}),
    })
  : createFakeReadingSetupEngine();
const askAiEndpoint = requireCompleteModelEndpoint(config.askAiModel, 'ask-ai');
if (!askAiEndpoint) {
  throw new Error(
    'ask-ai model is required: configure QA_AI_MODEL_API_BASE_URL, QA_AI_MODEL_API_KEY and QA_AI_MODEL_NAME (or the global MODEL_* fallback)',
  );
}
const askAiEngine = createAgentAskAiEngine({
  apiBaseUrl: askAiEndpoint.baseUrl,
  apiKey: askAiEndpoint.apiKey,
  modelName: askAiEndpoint.modelName,
});
const userBooks =
  database && books && contentGenerationQueue
    ? createUserBookService({
        db: database.db,
        books,
        setupEngine: readingSetupEngine,
        askAiEngine,
        generations: {
          async enqueue(input) {
            // Job id === generationId, so a repeat add for an already-known job is a no-op
            // in BullMQ. To honor §6.2 jump提权 we bump the priority of a still-waiting job
            // instead; a fresh job is added with the requested priority.
            const existing = await contentGenerationQueue.getJob(input.generationId);
            if (existing) {
              if (typeof input.priority === 'number') {
                const state = await existing.getState().catch(() => 'unknown');
                if (state === 'waiting' || state === 'prioritized' || state === 'delayed') {
                  await existing.changePriority({ priority: input.priority }).catch(() => {});
                }
              }
              return;
            }
            await contentGenerationQueue.add(
              'content.generate',
              {
                kind: 'content.generate',
                generationId: input.generationId,
                userBookId: input.userBookId,
                scope: input.scope,
                requestedAt: new Date().toISOString(),
              },
              {
                jobId: input.generationId,
                ...(typeof input.priority === 'number' ? { priority: input.priority } : {}),
              },
            );
          },
        },
        modelConfigId: `${modelEngine.name}:tailoring-content-1.0`,
      })
    : undefined;

const healthProbes: Record<string, () => Promise<void>> = {};
if (database) {
  healthProbes.database = async () => {
    await database.client`select 1`;
  };
}
if (systemQueue) {
  healthProbes.redis = async () => {
    await pingSystemQueue(systemQueue);
  };
}
if (objectStorage) {
  healthProbes.objectStorage = async () => {
    await objectStorage.list('health-probe');
  };
}

const app = await buildApp(config, {
  systemJobs,
  systemChat,
  healthProbes,
  books,
  bookImports,
  userBooks,
  auth,
  profiles,
  perfSink,
});

app.log.info({ model: modelEngine.name }, 'model engine ready');
if (!systemChatEndpoint) {
  app.log.warn('system chat model not configured: chat will use the fake echo engine');
}
if (!systemJobs) {
  app.log.warn('system job pipeline disabled: DATABASE_URL and REDIS_URL are both required');
}
if (!systemChat) {
  app.log.warn('system chat disabled: DATABASE_URL is required');
}
if (!books) {
  app.log.warn('book catalog disabled: DATABASE_URL and object storage are both required');
}
if (!bookImports) {
  app.log.warn('book import disabled: DATABASE_URL, REDIS_URL and object storage are required');
}
if (!userBooks) {
  app.log.warn(
    'user book workflow disabled: DATABASE_URL, REDIS_URL and object storage are required',
  );
}
if (!auth) {
  app.log.warn('authentication disabled: DATABASE_URL and AUTH_COOKIE_SECRET are required');
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down api');
  // 兜底：活跃的 SSE 长连接会让 app.close() 一直等，限时后强制退出，避免只能被 SIGKILL。
  setTimeout(() => process.exit(1), 10_000).unref();
  await app.close();
  await systemQueue?.close();
  await normalizationQueue?.close();
  await contentGenerationQueue?.close();
  await database?.client.end({ timeout: 5 });
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
