import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const schemaPrefix = 'readtailor_test_';
const require = createRequire(import.meta.url);
const postgres = require('postgres') as typeof import('postgres');

export default async function setup() {
  const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
  if (!databaseUrl) return;

  const runId = `${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
  process.env.READTAILOR_DB_TEST_RUN_ID = runId;

  return async () => {
    const admin = postgres(databaseUrl, { max: 1, onnotice: () => {} });
    const prefix = `${schemaPrefix}${runId}_w`;
    try {
      const schemas = await admin<{ schema_name: string }[]>`
        select nspname as schema_name
        from pg_catalog.pg_namespace
        where nspname like ${`${prefix}%`}
      `;
      for (const { schema_name: schemaName } of schemas) {
        if (/^[a-z_][a-z0-9_]*$/.test(schemaName)) {
          await admin`drop schema if exists ${admin(schemaName)} cascade`;
        }
      }
    } finally {
      await admin.end({ timeout: 5 });
    }
  };
}
