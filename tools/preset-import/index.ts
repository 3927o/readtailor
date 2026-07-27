/**
 * Preset 导入 CLI 入口：装配数据库和对象存储后调用无环境依赖的导入核心。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readOptionalBoolean } from '@readtailor/config';
import { createDatabase } from '@readtailor/database';
import { createObjectStorage } from '@readtailor/storage';
import { createPresetImportRepository } from './database';
import { importPresetBooks } from './importer';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export async function runPresetImportCli(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  const storage = createObjectStorage({
    localRoot: process.env.OBJECT_STORAGE_LOCAL_ROOT?.trim()
      ? resolve(REPO_ROOT, process.env.OBJECT_STORAGE_LOCAL_ROOT.trim())
      : undefined,
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT?.trim(),
    region: process.env.OBJECT_STORAGE_REGION?.trim() || undefined,
    bucket: process.env.OBJECT_STORAGE_BUCKET?.trim(),
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim(),
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim(),
    forcePathStyle: readOptionalBoolean(process.env, 'OBJECT_STORAGE_FORCE_PATH_STYLE'),
  });
  if (!storage) {
    throw new Error('object storage is required (OBJECT_STORAGE_LOCAL_ROOT or OBJECT_STORAGE_BUCKET)');
  }

  const database = createDatabase(databaseUrl);
  try {
    const result = await importPresetBooks({
      rootDirectory: resolve(REPO_ROOT, process.argv[2] ?? 'preset-books'),
      repository: createPresetImportRepository(database.db),
      storage,
    });
    process.stdout.write(
      `Preset import completed: imported=${result.imported.length} skipped=${result.skipped.length}\n`,
    );
  } finally {
    await database.client.end({ timeout: 5 });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
  void runPresetImportCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
