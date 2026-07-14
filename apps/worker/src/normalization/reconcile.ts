import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { normalizationRuns, sharedBooks, type Database } from '@readtailor/database';

/**
 * 单 worker 部署下，进程启动时仍处于 `running` 的规范化 run 一定是上一个进程崩溃、被杀或
 * 重启留下的孤儿：normalization 队列 attempts=1，BullMQ 不会重投，这些 run 会永远卡在
 * `running`，书籍也一直停在处理中。启动时把它们回收成 `stale_worker` 失败，用户即可通过
 * 重试重新排队。这里只做便宜的崩溃兜底，不重跑 Agent，也不产生额外模型成本。
 */
export async function reconcileOrphanedNormalizationRuns(options: {
  db: Database;
  logger: Logger;
}): Promise<number> {
  const orphaned = await options.db
    .update(normalizationRuns)
    .set({
      status: 'failed',
      failureType: 'stale_worker',
      errorSummary: '处理进程中断',
      completedAt: sql`now()`,
      heartbeatAt: sql`now()`,
    })
    .where(eq(normalizationRuns.status, 'running'))
    .returning({ id: normalizationRuns.id, bookId: normalizationRuns.sharedBookId });

  if (orphaned.length === 0) return 0;

  const bookIds = [...new Set(orphaned.map((run) => run.bookId))];
  await options.db
    .update(sharedBooks)
    .set({ status: 'failed', failureType: 'stale_worker', updatedAt: sql`now()` })
    .where(and(inArray(sharedBooks.id, bookIds), sql`${sharedBooks.currentPackageId} is null`));

  options.logger.warn(
    { runIds: orphaned.map((run) => run.id), bookIds },
    'recovered orphaned normalization runs left running by a previous worker',
  );
  return orphaned.length;
}
