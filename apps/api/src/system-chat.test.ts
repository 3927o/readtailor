import { describe, expect, it } from 'vitest';
import type { Database } from '@readtailor/database';
import type { ModelEngine } from '@readtailor/model';
import { createSystemChatService } from './system-chat';

const JOB_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';

function createFakeDb() {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: () => ({
        returning: async () => [{ id: JOB_ID }],
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          updates.push(patch);
        },
      }),
    }),
  } as unknown as Database;
  return { db, updates };
}

const echoEngine: ModelEngine = {
  name: 'fake',
  async *streamChat(prompt) {
    yield { type: 'content', text: `回声：${prompt}` };
    yield { type: 'content', text: '。' };
  },
};

describe('createSystemChatService', () => {
  it('marks the job completed with the full reply after a normal stream', async () => {
    const { db, updates } = createFakeDb();
    const service = createSystemChatService({ db, engine: echoEngine });

    const events = [];
    for await (const event of service.stream('你好')) {
      events.push(event);
    }

    expect(events[0]).toEqual({ type: 'job', jobId: JOB_ID, model: 'fake' });
    expect(events.at(-1)).toEqual({ type: 'done', jobId: JOB_ID });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: 'completed', result: { reply: '回声：你好。' } });
  });

  it('marks the job failed when the engine throws midway', async () => {
    const { db, updates } = createFakeDb();
    const brokenEngine: ModelEngine = {
      name: 'fake',
      async *streamChat() {
        yield { type: 'content', text: '一半' };
        throw new Error('boom');
      },
    };
    const service = createSystemChatService({ db, engine: brokenEngine });

    const consume = async () => {
      for await (const _event of service.stream('你好')) {
        // 只消费，等待中途抛错
      }
    };

    await expect(consume()).rejects.toThrow('boom');
    expect(updates).toEqual([{ status: 'failed' }]);
  });

  it('marks the job failed when the client disconnects midway', async () => {
    const { db, updates } = createFakeDb();
    const service = createSystemChatService({ db, engine: echoEngine });

    const stream = service.stream('你好');
    await stream.next(); // job 事件
    await stream.next(); // 第一段内容
    await stream.return(undefined); // 模拟客户端断开：生成器被提前 return

    expect(updates).toEqual([{ status: 'failed' }]);
  });
});
