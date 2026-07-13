import { describe, expect, it } from 'vitest';
import type { SystemJob } from '@readtailor/contracts';
import { buildApp } from './app';
import { loadApiConfig } from './config';
import type { SystemChatService } from './system-chat';
import type { SystemJobService } from './system-jobs';

const JOB_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';

function createFakeService(job: SystemJob | null): SystemJobService {
  return {
    async enqueuePing() {
      return { jobId: JOB_ID };
    },
    async getJob(id) {
      return job && job.id === id ? job : null;
    },
  };
}

const config = loadApiConfig({ LOG_LEVEL: 'silent' });

describe('POST /v1/system/ping', () => {
  it('enqueues a job and returns its id', async () => {
    const app = await buildApp(config, { systemJobs: createFakeService(null) });
    const response = await app.inject({ method: 'POST', url: '/v1/system/ping' });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ jobId: JOB_ID });
  });

  it('returns 503 when the pipeline is not configured', async () => {
    const app = await buildApp(config);
    const response = await app.inject({ method: 'POST', url: '/v1/system/ping' });

    expect(response.statusCode).toBe(503);
  });
});

describe('GET /v1/system/jobs/:id', () => {
  const job: SystemJob = {
    id: JOB_ID,
    kind: 'system.ping',
    status: 'completed',
    result: null,
    createdAt: '2026-07-13T00:00:00.000Z',
    completedAt: '2026-07-13T00:00:01.000Z',
  };

  it('returns the job by id', async () => {
    const app = await buildApp(config, { systemJobs: createFakeService(job) });
    const response = await app.inject({ method: 'GET', url: `/v1/system/jobs/${JOB_ID}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(job);
  });

  it('returns 404 for an unknown job', async () => {
    const app = await buildApp(config, { systemJobs: createFakeService(null) });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/system/jobs/00000000-0000-0000-0000-000000000000',
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects a malformed job id', async () => {
    const app = await buildApp(config, { systemJobs: createFakeService(job) });
    const response = await app.inject({ method: 'GET', url: '/v1/system/jobs/not-a-uuid' });

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /v1/system/chat', () => {
  const fakeChat: SystemChatService = {
    async *stream(prompt) {
      yield { type: 'job', jobId: JOB_ID, model: 'fake' };
      yield { type: 'content', text: `回声：${prompt}` };
      yield { type: 'done', jobId: JOB_ID };
    },
  };

  it('streams SSE events and finishes with done', async () => {
    const app = await buildApp(config, { systemChat: fakeChat });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/system/chat',
      payload: { prompt: '你好' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const events = response.body
      .split('\n\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line.replace(/^data: /, '')));
    expect(events).toEqual([
      { type: 'job', jobId: JOB_ID, model: 'fake' },
      { type: 'content', text: '回声：你好' },
      { type: 'done', jobId: JOB_ID },
    ]);
  });

  it('emits an in-band error event when the stream fails midway', async () => {
    const brokenChat: SystemChatService = {
      async *stream() {
        yield { type: 'job', jobId: JOB_ID, model: 'fake' };
        throw new Error('boom');
      },
    };
    const app = await buildApp(config, { systemChat: brokenChat });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/system/chat',
      payload: { prompt: '你好' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"error"');
  });

  it('rejects an empty prompt', async () => {
    const app = await buildApp(config, { systemChat: fakeChat });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/system/chat',
      payload: { prompt: '' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 503 when chat is not configured', async () => {
    const app = await buildApp(config);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/system/chat',
      payload: { prompt: '你好' },
    });

    expect(response.statusCode).toBe(503);
  });
});
