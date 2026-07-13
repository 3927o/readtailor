import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  clean: true,
  sourcemap: true,
  noExternal: [/^@readtailor\//],
  external: ['bullmq', 'drizzle-orm', 'ioredis', 'pino', 'postgres'],
});
