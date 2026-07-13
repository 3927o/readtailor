import { eq } from 'drizzle-orm';
import { systemJobs } from '@readtailor/database';
import type { Database } from '@readtailor/database';
import type { SystemQueue } from '@readtailor/queue';
import type { SystemJob, SystemJobStatus } from '@readtailor/contracts';

export interface SystemJobService {
  enqueuePing(): Promise<{ jobId: string }>;
  getJob(id: string): Promise<SystemJob | null>;
}

export function createSystemJobService(options: {
  db: Database;
  queue: SystemQueue;
}): SystemJobService {
  const { db, queue } = options;

  return {
    async enqueuePing() {
      const requestedAt = new Date().toISOString();
      const [row] = await db
        .insert(systemJobs)
        .values({ kind: 'system.ping', status: 'queued', payload: { requestedAt } })
        .returning({ id: systemJobs.id });
      if (!row) {
        throw new Error('failed to insert system job');
      }

      await queue.add('system.ping', { jobId: row.id, kind: 'system.ping', requestedAt });
      return { jobId: row.id };
    },

    async getJob(id) {
      const [row] = await db.select().from(systemJobs).where(eq(systemJobs.id, id)).limit(1);
      if (!row) {
        return null;
      }

      return {
        id: row.id,
        kind: row.kind,
        status: row.status as SystemJobStatus,
        result: (row.result as Record<string, unknown> | null) ?? null,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
      };
    },
  };
}
