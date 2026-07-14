import { eq, sql } from 'drizzle-orm';
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core';
import { systemJobs } from '@readtailor/database';
import type { Database } from '@readtailor/database';
import type { ModelEngine } from '@readtailor/model';
import type { PerfSink } from '@readtailor/observability';

export type SystemChatEvent =
  | { type: 'job'; jobId: string; model: string }
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'done'; jobId: string }
  | { type: 'error'; message: string };

export interface SystemChatService {
  stream(prompt: string, context?: { requestId?: string }): AsyncGenerator<SystemChatEvent>;
}

export function createSystemChatService(options: {
  db: Database;
  engine: ModelEngine;
  perfSink?: PerfSink;
}): SystemChatService {
  const { db, engine } = options;

  return {
    async *stream(prompt, context = {}) {
      const [row] = await db
        .insert(systemJobs)
        .values({ kind: 'system.chat', status: 'queued', payload: { prompt, model: engine.name } })
        .returning({ id: systemJobs.id });
      if (!row) {
        throw new Error('failed to insert system job');
      }

      let settled = false;
      const settle = async (patch: PgUpdateSetSource<typeof systemJobs>) => {
        await db.update(systemJobs).set(patch).where(eq(systemJobs.id, row.id));
        // 更新成功后才算落了终态；提前置位会让写库失败时 finally 的兜底失效。
        settled = true;
      };
      const started = performance.now();
      let reply = '';
      let agentCallRecorded = false;
      const recordAgentCall = (status: 'ok' | 'error', errorSummary?: string) => {
        if (agentCallRecorded) return;
        agentCallRecorded = true;
        options.perfSink?.recordAgentCall({
          requestId: context.requestId ?? null,
          source: 'api',
          kind: 'system_chat',
          model: engine.name,
          status,
          durationMs: performance.now() - started,
          promptChars: prompt.length,
          outputChars: reply.length,
          ...(errorSummary ? { errorSummary } : {}),
        });
      };

      try {
        yield { type: 'job', jobId: row.id, model: engine.name };

        for await (const event of engine.streamChat(prompt)) {
          if (event.type === 'content') {
            reply += event.text;
          }
          yield event;
        }

        // created_at 由数据库时钟生成，完成时间也用 now() 以免本机时钟偏差造成先完成后创建。
        await settle({ status: 'completed', completedAt: sql`now()`, result: { reply } });
        recordAgentCall('ok');
        yield { type: 'done', jobId: row.id };
      } catch (error) {
        // 尽力落 failed，但不覆盖原始错误；写库再失败由 finally 兜底重试一次。
        await settle({ status: 'failed' }).catch(() => undefined);
        recordAgentCall('error', (error instanceof Error ? error.message : String(error)).slice(0, 1000));
        throw error;
      } finally {
        if (!settled) {
          // 客户端中途断开时生成器被提前 return，不走 catch，在这里兜底落终态。
          await settle({ status: 'failed' }).catch(() => undefined);
          recordAgentCall('error', 'system chat stream closed before completion');
        }
      }
    },
  };
}
