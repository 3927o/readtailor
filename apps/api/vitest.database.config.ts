import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  root: repoRoot,
  test: {
    name: 'api-postgres',
    include: [
      'apps/api/src/**/*.db.test.ts',
      'apps/worker/src/**/*.db.test.ts',
    ],
    setupFiles: ['apps/api/src/test/database/setup.ts'],
    globalSetup: ['apps/api/src/test/database/global-setup.ts'],
    pool: 'forks',
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
