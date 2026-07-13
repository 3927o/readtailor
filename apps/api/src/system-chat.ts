import { eq } from 'drizzle-orm';
import { systemJobs } from '@readtailor/database';
import type { Database } from '@readtailor/database';
import type { ModelEngine } from '@readtailor/model';

export type SystemChatEvent =
  | { type: 'job'; jobId: string; model: string }
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string }
  | { type: 'done'; jobId: string };

export interface SystemChatService {
  stream(prompt: string): AsyncGenerator<SystemChatEvent>;
}

export function createSystemChatService(options: {
  db: Database;
  engine: ModelEngine;
}): SystemChatService {
  const { db, engine } = options;

  return {
    async *stream(prompt) {
      const [row] = await db
        .insert(systemJobs)
        .values({ kind: 'system.chat', status: 'queued', payload: { prompt, model: engine.name } })
        .returning({ id: systemJobs.id });
      if (!row) {
        throw new Error('failed to insert system job');
      }

      let settled = false;
      const settle = async (patch: Partial<typeof systemJobs.$inferInsert>) => {
        settled = true;
        await db.update(systemJobs).set(patch).where(eq(systemJobs.id, row.id));
      };

      try {
        yield { type: 'job', jobId: row.id, model: engine.name };

        let reply = '';
        for await (const event of engine.streamChat(prompt)) {
          if (event.type === 'content') {
            reply += event.text;
          }
          yield event;
        }

        await settle({ status: 'completed', completedAt: new Date(), result: { reply } });
        yield { type: 'done', jobId: row.id };
      } catch (error) {
        await settle({ status: 'failed' });
        throw error;
      } finally {
        if (!settled) {
          // 客户端中途断开时生成器被提前 return，不走 catch，在这里兜底落终态。
          await settle({ status: 'failed' });
        }
      }
    },
  };
}
