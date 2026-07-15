import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from '@readtailor/database';

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const database = createDatabase(databaseUrl);

try {
  await migrate(database.db, {
    migrationsFolder: resolve(repoRoot, 'packages/database/migrations'),
  });
  console.log('database migrations completed');
} finally {
  await database.client.end({ timeout: 5 });
}
