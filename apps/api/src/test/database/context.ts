import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Sql } from 'postgres';
import type { Database } from '@readtailor/database';
import * as schema from '@readtailor/database/schema';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
const migrationsFolder = resolve(repoRoot, 'packages/database/migrations');
const identifierPattern = /^[a-z_][a-z0-9_]*$/;
const require = createRequire(import.meta.url);
const postgres = require('postgres') as typeof import('postgres');

export const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL?.trim());

export interface TestDatabaseContext {
  schemaName: string;
  client: Sql;
  db: Database;
}

let currentContext: TestDatabaseContext | null = null;
let initializePromise: Promise<TestDatabaseContext> | null = null;

function safeIdentifierPart(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!/^[a-z0-9_]+$/.test(normalized)) {
    throw new Error(`Invalid PostgreSQL test identifier: ${value}`);
  }
  return normalized;
}

function workerSchemaName(): string {
  const runId = safeIdentifierPart(
    process.env.READTAILOR_DB_TEST_RUN_ID ?? `local_${process.pid}`,
  );
  const workerId = safeIdentifierPart(
    process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '1',
  );
  const schemaName = `readtailor_test_${runId}_w${workerId}`.slice(0, 63);
  if (!identifierPattern.test(schemaName)) {
    throw new Error(`Invalid PostgreSQL test schema: ${schemaName}`);
  }
  return schemaName;
}

async function createSchemaScopedMigrations(schemaName: string): Promise<string> {
  const temporaryFolder = await mkdtemp(join(tmpdir(), 'readtailor-migrations-'));
  const metaFolder = join(temporaryFolder, 'meta');
  await mkdir(metaFolder);

  const journalPath = join(migrationsFolder, 'meta/_journal.json');
  const journalSource = await readFile(journalPath, 'utf8');
  const journal = JSON.parse(journalSource) as {
    entries: Array<{ tag: string }>;
  };
  await writeFile(join(metaFolder, '_journal.json'), journalSource);

  for (const entry of journal.entries) {
    const source = await readFile(join(migrationsFolder, `${entry.tag}.sql`), 'utf8');
    const scoped = source.replaceAll('"public".', `"${schemaName}".`);
    await writeFile(join(temporaryFolder, `${entry.tag}.sql`), scoped);
  }

  return temporaryFolder;
}

async function provisionTestDatabase(): Promise<TestDatabaseContext> {
  const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('TEST_DATABASE_URL is required for PostgreSQL integration tests');
  }

  const schemaName = workerSchemaName();
  const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    await admin`create schema if not exists ${admin(schemaName)}`;
  } finally {
    await admin.end({ timeout: 5 });
  }

  const client = postgres(databaseUrl, {
    max: 1,
    onnotice: () => {},
    connection: {
      application_name: `readtailor-test-${schemaName}`,
      search_path: schemaName,
    },
  });
  const db = drizzle(client, { schema }) as Database;
  const temporaryMigrations = await createSchemaScopedMigrations(schemaName);

  try {
    await migrate(db, {
      migrationsFolder: temporaryMigrations,
      migrationsSchema: schemaName,
      migrationsTable: '__drizzle_migrations',
    });
  } catch (error) {
    await client.end({ timeout: 5 });
    throw error;
  } finally {
    await rm(temporaryMigrations, { recursive: true, force: true });
  }

  return { schemaName, client, db };
}

export async function initializeTestDatabase(): Promise<TestDatabaseContext> {
  if (currentContext) return currentContext;
  initializePromise ??= provisionTestDatabase();
  try {
    currentContext = await initializePromise;
    return currentContext;
  } catch (error) {
    initializePromise = null;
    throw error;
  }
}

export function getTestDatabase(): TestDatabaseContext {
  if (!currentContext) {
    throw new Error('PostgreSQL test context has not been initialized');
  }
  return currentContext;
}

export async function resetTestDatabase(): Promise<void> {
  const { client, schemaName } = getTestDatabase();
  const tables = await client<{ tablename: string }[]>`
    select tablename
    from pg_catalog.pg_tables
    where schemaname = ${schemaName}
      and tablename <> '__drizzle_migrations'
  `;
  if (tables.length === 0) return;

  const qualifiedTables = tables
    .map(({ tablename }) => `"${schemaName}"."${tablename.replaceAll('"', '""')}"`)
    .join(', ');
  await client.unsafe(`truncate table ${qualifiedTables} restart identity cascade`);
}

export async function closeTestDatabase(): Promise<void> {
  if (currentContext) {
    await currentContext.client.end({ timeout: 5 });
  }
  currentContext = null;
  initializePromise = null;
}
