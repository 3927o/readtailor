import { describe, expect, it } from 'vitest';
import type { SystemJob } from '@readtailor/contracts';
import { buildApp } from './app';
import { loadApiConfig } from './config';
import type { SystemChatService } from './system-chat';
import type { SystemJobService } from './system-jobs';
import type { BookService } from './books';

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

const fakeBooks: BookService = {
  async getBook(id) {
    return {
      id,
      epubSha256: 'a'.repeat(64),
      status: 'ready',
      title: 'Book',
      authors: ['Author'],
      language: 'zh',
      coverPath: 'assets/cover.jpg',
      identifiers: {},
      publisher: null,
      publishedDate: null,
      sourceFilename: 'book.epub',
      package: {
        id: 'd08c8fca-8c88-485f-b674-9a332c00abf8',
        version: 'v1',
        contractVersion: 'nb-1.0',
        manifestVersion: 'reading-nodes-1.0',
        createdAt: '2026-07-13T00:00:00.000Z',
      },
    };
  },
  async getManifest() {
    return { version: 'reading-nodes-1.0' };
  },
  async getProfile() {
    return { version: 'book-profile-1.0' };
  },
  async getContent() {
    return new TextEncoder().encode('<main id="book"></main>');
  },
  async getAsset() {
    return new Uint8Array([1, 2, 3]);
  },
};

describe('GET /v1/health', () => {
  it('reports ok without configured probes', async () => {
    const app = await buildApp(config);
    const response = await app.inject({ method: 'GET', url: '/v1/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.dependencies).toBeUndefined();
  });

  it('reports dependency status when all probes pass', async () => {
    const app = await buildApp(config, {
      healthProbes: {
        database: async () => {},
        redis: async () => {},
      },
    });
    const response = await app.inject({ method: 'GET', url: '/v1/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json().dependencies).toEqual({ database: 'ok', redis: 'ok' });
  });

  it('returns 503 degraded when a probe fails', async () => {
    const app = await buildApp(config, {
      healthProbes: {
        database: async () => {},
        redis: async () => {
          throw new Error('redis down');
        },
      },
    });
    const response = await app.inject({ method: 'GET', url: '/v1/health' });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe('degraded');
    expect(body.dependencies).toEqual({ database: 'ok', redis: 'error' });
  });
});

describe('ready book routes', () => {
  it('returns metadata, manifest, content and package assets', async () => {
    const app = await buildApp(config, { books: fakeBooks });
    const book = await app.inject({ method: 'GET', url: `/v1/books/${JOB_ID}` });
    expect(book.statusCode).toBe(200);
    expect(book.json().status).toBe('ready');

    const manifest = await app.inject({ method: 'GET', url: `/v1/books/${JOB_ID}/manifest` });
    expect(manifest.json()).toEqual({ version: 'reading-nodes-1.0' });

    const content = await app.inject({ method: 'GET', url: `/v1/books/${JOB_ID}/content` });
    expect(content.headers['content-type']).toContain('text/html');
    expect(content.body).toContain('<main');

    const profile = await app.inject({ method: 'GET', url: `/v1/books/${JOB_ID}/profile` });
    expect(profile.json()).toEqual({ version: 'book-profile-1.0' });

    const asset = await app.inject({
      method: 'GET',
      url: `/v1/books/${JOB_ID}/assets/cover.jpg`,
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('image/jpeg');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns 503 when the catalog is not configured', async () => {
    const app = await buildApp(config);
    const response = await app.inject({ method: 'GET', url: `/v1/books/${JOB_ID}` });
    expect(response.statusCode).toBe(503);
  });
});

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

  it('returns 500 when the stream fails before the first event', async () => {
    const deadChat: SystemChatService = {
      async *stream() {
        throw new Error('database unavailable');
      },
    };
    const app = await buildApp(config, { systemChat: deadChat });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/system/chat',
      payload: { prompt: '你好' },
    });

    expect(response.statusCode).toBe(500);
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
