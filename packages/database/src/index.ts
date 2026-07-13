import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export function createDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, { max: 5 });
  return {
    client,
    db: drizzle(client, { schema }),
  };
}

export type Database = ReturnType<typeof createDatabase>['db'];

export * from './schema';
