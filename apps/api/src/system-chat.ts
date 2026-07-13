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

      yield { type: 'job', jobId: row.id, model: engine.name };

      let reply = '';
      try {
        for await (const event of engine.streamChat(prompt)) {
          if (event.type === 'content') {
            reply += event.text;
          }
          yield event;
        }
      } catch (error) {
        await db
          .update(systemJobs)
          .set({ status: 'failed' })
          .where(eq(systemJobs.id, row.id));
        throw error;
      }

      await db
        .update(systemJobs)
        .set({ status: 'completed', completedAt: new Date(), result: { reply } })
        .where(eq(systemJobs.id, row.id));

      yield { type: 'done', jobId: row.id };
    },
  };
}
