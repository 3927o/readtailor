import { describe, expect, it, vi } from 'vitest';
import type { SystemJob } from '@readtailor/contracts';
import { buildApp as buildApiApp, type AppDeps } from './app';
import { AuthError, type AuthService } from './auth';
import { loadApiConfig } from './config';
import type { SystemChatService } from './system-chat';
import type { SystemJobService } from './system-jobs';
import { BookImportError, type BookImportService } from './book-imports';
import type { BookService } from './books';
import { createReadingManifestFixture } from './test/reading-manifest';

const JOB_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const TEST_ORIGIN = 'http://localhost:5173';
const SYSTEM_TOKEN = 'test-system-token';
const systemHeaders = { authorization: `Bearer ${SYSTEM_TOKEN}` };

const fakeAuth: AuthService = {
  async authenticateSession() {
    return {
      user: {
        id: JOB_ID,
        displayName: 'Reader',
        avatarUrl: null,
        email: 'reader@example.com',
        readerProfileCompletedAt: new Date(),
      },
      expiresAt: new Date('2026-08-14T00:00:00.000Z'),
    };
  },
  beginGoogleLogin() { throw new Error('not used'); },
  async completeGoogleLogin() { throw new Error('not used'); },
  async registerWithPassword() { throw new Error('not used'); },
  async loginWithPassword() { throw new Error('not used'); },
  async developmentLogin() { throw new Error('not used'); },
  async logout() {},
};

function buildApp(config: ReturnType<typeof loadApiConfig>, deps: AppDeps = {}) {
  return buildApiApp(config, { auth: fakeAuth, ...deps });
}

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

const config = loadApiConfig({ LOG_LEVEL: 'silent', SYSTEM_API_TOKEN: SYSTEM_TOKEN });

const catalogBook = {
  id: JOB_ID,
  epubSha256: 'a'.repeat(64),
  status: 'ready' as const,
  title: 'Book',
  authors: ['Author'],
  coverPath: 'assets/cover.jpg',
  sourceFilename: 'book.epub',
  errorSummary: null,
  failureType: null,
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:01.000Z',
};

const fakeBooks: BookService = {
  async canAccess() {
    return true;
  },
  async listBooks() {
    return [catalogBook];
  },
  async getNormalizationStatus(id) {
    return id === JOB_ID ? { book: catalogBook, run: null } : null;
  },
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
    return createReadingManifestFixture([]);
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

describe('authentication boundary', () => {
  it('returns the current session user', async () => {
    const app = await buildApp(config);
    const response = await app.inject({ method: 'GET', url: '/v1/auth/session' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      user: {
        id: JOB_ID,
        displayName: 'Reader',
        avatarUrl: null,
        email: 'reader@example.com',
        readerProfileCompleted: true,
      },
    });
  });

  it('rejects protected routes without an active session', async () => {
    const app = await buildApiApp(config, {
      auth: { ...fakeAuth, async authenticateSession() { return null; } },
    });
    const response = await app.inject({ method: 'GET', url: '/v1/user-books' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: '请先登录' });
  });

  it('rejects authenticated writes from an untrusted origin', async () => {
    const app = await buildApp(config);
    const response = await app.inject({ method: 'POST', url: '/v1/books/import' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: '请求来源无效' });
  });

  it('registers with a password and sets the server session cookie', async () => {
    const registerWithPassword = vi.fn<AuthService['registerWithPassword']>(async () => ({
      user: {
        id: JOB_ID,
        displayName: 'New Reader',
        avatarUrl: null,
        email: 'reader@example.com',
        readerProfileCompletedAt: null,
      },
      sessionToken: 'new-session-token',
      expiresAt: new Date('2026-08-14T00:00:00.000Z'),
    }));
    const app = await buildApp(config, { auth: { ...fakeAuth, registerWithPassword } });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: {
        displayName: 'New Reader',
        email: 'reader@example.com',
        password: 'correct horse battery staple',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().user).toMatchObject({
      email: 'reader@example.com',
      readerProfileCompleted: false,
    });
    expect(response.headers['set-cookie']).toContain('readtailor_session=new-session-token');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
    expect(response.headers['set-cookie']).toContain('SameSite=Lax');
    expect(registerWithPassword).toHaveBeenCalledWith({
      displayName: 'New Reader',
      email: 'reader@example.com',
      password: 'correct horse battery staple',
    });
  });

  it('rejects password login from an untrusted origin before checking credentials', async () => {
    const loginWithPassword = vi.fn<AuthService['loginWithPassword']>();
    const app = await buildApp(config, { auth: { ...fakeAuth, loginWithPassword } });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: 'https://example.com', 'content-type': 'application/json' },
      payload: { email: 'reader@example.com', password: 'password' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: '请求来源无效' });
    expect(loginWithPassword).not.toHaveBeenCalled();
  });

  it('returns the generic credential error from password login', async () => {
    const app = await buildApp(config, {
      auth: {
        ...fakeAuth,
        async loginWithPassword() {
          throw new AuthError('邮箱或密码错误', 401, 'invalid_credentials');
        },
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { origin: TEST_ORIGIN, 'content-type': 'application/json' },
      payload: { email: 'reader@example.com', password: 'wrong' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: '邮箱或密码错误' });
  });

  it('does not reveal a shared book the current user does not own', async () => {
    const app = await buildApp(config, {
      books: { ...fakeBooks, async canAccess() { return false; } },
    });
    const response = await app.inject({ method: 'GET', url: `/v1/books/${JOB_ID}` });

    expect(response.statusCode).toBe(404);
  });
});

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
  it('returns the shelf catalog and normalization status', async () => {
    const app = await buildApp(config, { books: fakeBooks });
    const catalog = await app.inject({ method: 'GET', url: '/v1/books' });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json()).toEqual({ books: [catalogBook] });

    const status = await app.inject({ method: 'GET', url: `/v1/books/${JOB_ID}/status` });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ book: catalogBook, run: null });
  });

  it('returns metadata, manifest, content and package assets', async () => {
    const app = await buildApp(config, { books: fakeBooks });
    const book = await app.inject({ method: 'GET', url: `/v1/books/${JOB_ID}` });
    expect(book.statusCode).toBe(200);
    expect(book.json().status).toBe('ready');

    const manifest = await app.inject({ method: 'GET', url: `/v1/books/${JOB_ID}/manifest` });
    expect(manifest.json()).toEqual(createReadingManifestFixture([]));

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

describe('POST /v1/books/import', () => {
  it('accepts a multipart EPUB and returns the queued book', async () => {
    const bookImports: BookImportService = {
      async importBook(_userId, input) {
        expect(input.filename).toBe('book.epub');
        expect(input.mediaType).toBe('application/epub+zip');
        expect([...input.bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
        return { bookId: JOB_ID, runId: JOB_ID, reused: false, status: 'queued' };
      },
      async retryBook() {
        return { bookId: JOB_ID, runId: JOB_ID, reused: false, status: 'queued' };
      },
    };
    const boundary = 'readtailor-test-boundary';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="book.epub"\r\nContent-Type: application/epub+zip\r\n\r\n`,
      ),
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const app = await buildApp(config, { bookImports });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/books/import',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        origin: TEST_ORIGIN,
      },
      payload,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      bookId: JOB_ID,
      runId: JOB_ID,
      reused: false,
      status: 'queued',
    });
  });

  it('returns 503 when the import pipeline is not configured', async () => {
    const app = await buildApp(config);
    const response = await app.inject({ method: 'POST', url: '/v1/books/import', headers: { origin: TEST_ORIGIN } });
    expect(response.statusCode).toBe(503);
  });
});

describe('POST /v1/books/:id/retry', () => {
  it('requeues a failed book without re-uploading the file', async () => {
    const bookImports: BookImportService = {
      async importBook() {
        throw new Error('not used');
      },
      async retryBook(_userId, bookId) {
        expect(bookId).toBe(JOB_ID);
        return { bookId: JOB_ID, runId: JOB_ID, reused: false, status: 'queued' };
      },
    };
    const app = await buildApp(config, { bookImports });
    const response = await app.inject({ method: 'POST', url: `/v1/books/${JOB_ID}/retry`, headers: { origin: TEST_ORIGIN } });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({
      bookId: JOB_ID,
      runId: JOB_ID,
      reused: false,
      status: 'queued',
    });
  });

  it('surfaces the missing-source conflict from the pipeline', async () => {
    const bookImports: BookImportService = {
      async importBook() {
        throw new Error('not used');
      },
      async retryBook() {
        throw new BookImportError('找不到源文件，请重新上传', 409);
      },
    };
    const app = await buildApp(config, { bookImports });
    const response = await app.inject({ method: 'POST', url: `/v1/books/${JOB_ID}/retry`, headers: { origin: TEST_ORIGIN } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: '找不到源文件，请重新上传' });
  });

  it('returns 503 when the import pipeline is not configured', async () => {
    const app = await buildApp(config);
    const response = await app.inject({ method: 'POST', url: `/v1/books/${JOB_ID}/retry`, headers: { origin: TEST_ORIGIN } });
    expect(response.statusCode).toBe(503);
  });
});

describe('POST /v1/system/ping', () => {
  it('enqueues a job and returns its id', async () => {
    const app = await buildApp(config, { systemJobs: createFakeService(null) });
    const response = await app.inject({ method: 'POST', url: '/v1/system/ping', headers: systemHeaders });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ jobId: JOB_ID });
  });

  it('returns 503 when the pipeline is not configured', async () => {
    const app = await buildApp(config);
    const response = await app.inject({ method: 'POST', url: '/v1/system/ping', headers: systemHeaders });

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
    const response = await app.inject({ method: 'GET', url: `/v1/system/jobs/${JOB_ID}`, headers: systemHeaders });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(job);
  });

  it('returns 404 for an unknown job', async () => {
    const app = await buildApp(config, { systemJobs: createFakeService(null) });
    const response = await app.inject({
      method: 'GET',
      url: '/v1/system/jobs/00000000-0000-0000-0000-000000000000',
      headers: systemHeaders,
    });

    expect(response.statusCode).toBe(404);
  });

  it('rejects a malformed job id', async () => {
    const app = await buildApp(config, { systemJobs: createFakeService(job) });
    const response = await app.inject({ method: 'GET', url: '/v1/system/jobs/not-a-uuid', headers: systemHeaders });

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
      headers: systemHeaders,
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
      headers: systemHeaders,
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
      headers: systemHeaders,
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
      headers: systemHeaders,
      payload: { prompt: '' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('returns 503 when chat is not configured', async () => {
    const app = await buildApp(config);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/system/chat',
      headers: systemHeaders,
      payload: { prompt: '你好' },
    });

    expect(response.statusCode).toBe(503);
  });
});
