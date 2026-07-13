import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit only auto-loads .env from its own cwd; the shared file lives at the repo root.
const rootEnvPath = resolve(process.cwd(), '../../.env');
if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for database commands');
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
