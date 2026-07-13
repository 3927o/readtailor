import { createDatabase } from '@readtailor/database';
import { createFakeModelEngine, createOpenAiCompatibleEngine } from '@readtailor/model';
import { createSystemQueue } from '@readtailor/queue';
import { buildApp } from './app';
import { loadApiConfig } from './config';
import { createSystemChatService } from './system-chat';
import { createSystemJobService } from './system-jobs';

const config = loadApiConfig();

const database = config.databaseUrl ? createDatabase(config.databaseUrl) : undefined;
const systemQueue = config.redisUrl ? createSystemQueue(config.redisUrl) : undefined;
const systemJobs =
  database && systemQueue
    ? createSystemJobService({ db: database.db, queue: systemQueue })
    : undefined;

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

const app = await buildApp(config, { systemJobs, systemChat });

app.log.info({ model: modelEngine.name }, 'model engine ready');
if (!systemJobs) {
  app.log.warn('system job pipeline disabled: DATABASE_URL and REDIS_URL are both required');
}
if (!systemChat) {
  app.log.warn('system chat disabled: DATABASE_URL is required');
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down api');
  await app.close();
  await systemQueue?.close();
  await database?.client.end({ timeout: 5 });
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
