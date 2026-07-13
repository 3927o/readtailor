import { eq } from 'drizzle-orm';
import { systemJobs } from '@readtailor/database';
import type { Database } from '@readtailor/database';
import type { SystemQueue } from '@readtailor/queue';
import type { SystemJob } from '@readtailor/contracts';

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

      try {
        // jobId 用数据库行 ID：队列日志可直接对上表记录，重复入队也会被去重。
        await queue.add(
          'system.ping',
          { jobId: row.id, kind: 'system.ping', requestedAt },
          { jobId: row.id },
        );
      } catch (error) {
        // 入队失败时把行落成 failed，避免留下永远 queued 的孤儿行；失败本身继续上抛。
        await db
          .update(systemJobs)
          .set({ status: 'failed' })
          .where(eq(systemJobs.id, row.id))
          .catch(() => undefined);
        throw error;
      }
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
        status: row.status,
        result: row.result,
        createdAt: row.createdAt.toISOString(),
        completedAt: row.completedAt?.toISOString() ?? null,
      };
    },
  };
}
