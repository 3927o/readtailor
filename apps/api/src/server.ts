import { createDatabase } from '@readtailor/database';
import { createFakeModelEngine, createOpenAiCompatibleEngine } from '@readtailor/model';
import { createSystemQueue, pingSystemQueue } from '@readtailor/queue';
import { createObjectStorage } from '@readtailor/storage';
import { buildApp } from './app';
import { createBookService, createDatabaseBookRepository } from './books';
import { loadApiConfig } from './config';
import { createSystemChatService } from './system-chat';
import { createSystemJobService } from './system-jobs';

const config = loadApiConfig();
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const database = config.databaseUrl ? createDatabase(config.databaseUrl) : undefined;
const systemQueue = config.redisUrl ? createSystemQueue(config.redisUrl) : undefined;
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

const modelVars = [config.modelBaseUrl, config.modelApiKey, config.modelName];
const modelConfigured = modelVars.every(Boolean);
if (!modelConfigured && modelVars.some(Boolean)) {
  // 配置残缺时静默落到假模型会把假回声当成功答复端给用户，必须启动即失败。
  throw new Error(
    'partial model configuration: MODEL_API_BASE_URL, MODEL_API_KEY and MODEL_NAME must all be set (or none, to use the fake engine)',
  );
}

const modelEngine =
  config.modelBaseUrl && config.modelApiKey && config.modelName
    ? createOpenAiCompatibleEngine({
        baseUrl: config.modelBaseUrl,
        apiKey: config.modelApiKey,
        model: config.modelName,
      })
    : createFakeModelEngine();

const systemChat = database
  ? createSystemChatService({ db: database.db, engine: modelEngine })
  : undefined;
const books =
  database && objectStorage
    ? createBookService({
        repository: createDatabaseBookRepository(database.db),
        storage: objectStorage,
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

const app = await buildApp(config, { systemJobs, systemChat, healthProbes, books });

app.log.info({ model: modelEngine.name }, 'model engine ready');
if (!modelConfigured) {
  app.log.warn('MODEL_* not configured: chat will use the fake echo engine');
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

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down api');
  // 兜底：活跃的 SSE 长连接会让 app.close() 一直等，限时后强制退出，避免只能被 SIGKILL。
  setTimeout(() => process.exit(1), 10_000).unref();
  await app.close();
  await systemQueue?.close();
  await database?.client.end({ timeout: 5 });
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
