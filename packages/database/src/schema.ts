import { jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { SystemJobStatus } from '@readtailor/contracts';

export const systemJobs = pgTable('system_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  status: text('status').$type<SystemJobStatus>().notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  result: jsonb('result').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});
