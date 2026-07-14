import { describe, expect, it } from 'vitest';
import { buildApp as buildApiApp } from './app';
import type { AuthService } from './auth';
import { loadApiConfig } from './config';
import { UserBookError, type UserBookService, type UserBookUserService } from './user-books';

const USER_BOOK_ID = 'a3bb189e-8bf9-3888-9912-ace4e6543002';
const SHARED_BOOK_ID = 'd08c8fca-8c88-485f-b674-9a332c00abf8';
const READER_SETTINGS = { fontSize: 18, lineHeight: 1.95, contentWidth: 'medium', theme: 'system' } as const;
const fakeAuth: AuthService = {
  async authenticateSession() {
    return {
      user: {
        id: USER_BOOK_ID,
        displayName: 'Reader',
        avatarUrl: null,
        email: null,
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
const item = {
  id: USER_BOOK_ID,
  sharedBookId: SHARED_BOOK_ID,
  sharedBookStatus: 'ready' as const,
  workflowStatus: 'active_reading' as const,
  title: 'Book',
  authors: ['Author'],
  coverPath: null,
  errorSummary: null,
  failureType: null,
  progress: null,
  lastActivityAt: '2026-07-14T00:00:00.000Z',
};

function fakeService(overrides: Partial<UserBookUserService> = {}): UserBookService {
  const bound = {
    async list() {
      return { books: [item] };
    },
    async workflow() {
      return { workflowStatus: 'active_reading', book: item, interview: null, strategy: null, trial: null };
    },
    async reader() {
      return {
        userBookId: USER_BOOK_ID,
        sharedBookId: SHARED_BOOK_ID,
        workflowStatus: 'active_reading',
        briefing: 'Briefing',
        strategySummary: 'Strategy',
        enhancements: [],
        resumePosition: null,
        settings: READER_SETTINGS,
        readNodes: [],
      };
    },
    async reportReaderFocus() {
      return {
        userBookId: USER_BOOK_ID,
        sharedBookId: SHARED_BOOK_ID,
        workflowStatus: 'active_reading',
        briefing: 'Briefing',
        strategySummary: 'Strategy',
        enhancements: [],
        resumePosition: null,
        settings: READER_SETTINGS,
        readNodes: [],
      };
    },
    ...overrides,
  } as UserBookUserService;
  return { forUser: () => bound };
}

const config = loadApiConfig({ LOG_LEVEL: 'silent' });

function buildApp() {
  return buildApiApp(config, { auth: fakeAuth, userBooks: fakeService() });
}

describe('user book workflow routes', () => {
  it('serves the user shelf, workflow snapshot and reader bootstrap', async () => {
    const app = await buildApp();

    const shelf = await app.inject({ method: 'GET', url: '/v1/user-books' });
    expect(shelf.statusCode).toBe(200);
    expect(shelf.json()).toEqual({ books: [item] });

    const workflow = await app.inject({ method: 'GET', url: `/v1/user-books/${USER_BOOK_ID}/workflow` });
    expect(workflow.statusCode).toBe(200);
    expect(workflow.json().workflowStatus).toBe('active_reading');

    const reader = await app.inject({ method: 'GET', url: `/v1/user-books/${USER_BOOK_ID}/reader` });
    expect(reader.statusCode).toBe(200);
    expect(reader.json()).toMatchObject({ sharedBookId: SHARED_BOOK_ID, enhancements: [] });
  });

  it('reports reader focus and returns a fresh bootstrap', async () => {
    let reportedOrder: number | undefined;
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async reportReaderFocus(_userBookId, input) {
          reportedOrder = input.order;
          return {
            userBookId: USER_BOOK_ID,
            sharedBookId: SHARED_BOOK_ID,
            workflowStatus: 'active_reading',
            briefing: 'Briefing',
            strategySummary: 'Strategy',
            enhancements: [
              { generationId: 'g1', sectionId: 'chapter-3', segment: 1, status: 'queued', result: null },
            ],
            resumePosition: null,
            settings: READER_SETTINGS,
            readNodes: [],
          };
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/reader/focus`,
      headers: { origin: 'http://localhost:5173' },
      payload: { order: 12 },
    });

    expect(response.statusCode).toBe(200);
    expect(reportedOrder).toBe(12);
    expect(response.json()).toMatchObject({
      sharedBookId: SHARED_BOOK_ID,
      enhancements: [{ sectionId: 'chapter-3', status: 'queued' }],
    });
  });

  it('rejects a reader focus report with a non-positive order', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/reader/focus`,
      headers: { origin: 'http://localhost:5173' },
      payload: { order: 0 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns a conflict response for stale workflow commands', async () => {
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async approveStrategy() {
          throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
        },
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/strategy/approve`,
      headers: { origin: 'http://localhost:5173' },
      payload: { strategyDraftVersionId: SHARED_BOOK_ID },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: '处理方式已经更新，请刷新后继续' });
  });

  // §6.5: approve/adopt dropped their unused idempotencyKey (both are idempotent by state).
  // A body without the key must still be accepted — the schema no longer requires it.
  it('approves a strategy without an idempotency key', async () => {
    let received: unknown;
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async approveStrategy(_userBookId, input) {
          received = input;
          return {
            userBookId: USER_BOOK_ID,
            workflowStatus: 'trial_generating',
            strategyDraftVersionId: input.strategyDraftVersionId,
            trialRevisionId: SHARED_BOOK_ID,
          };
        },
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/strategy/approve`,
      headers: { origin: 'http://localhost:5173' },
      payload: { strategyDraftVersionId: SHARED_BOOK_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({ strategyDraftVersionId: SHARED_BOOK_ID });
    expect(response.json()).toMatchObject({ workflowStatus: 'trial_generating' });
  });

  it('adopts a trial without an idempotency key', async () => {
    let received: unknown;
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async adoptTrial(_userBookId, input) {
          received = input;
          return { userBookId: USER_BOOK_ID, workflowStatus: 'active_reading', strategyVersionId: SHARED_BOOK_ID };
        },
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/trial/adopt`,
      headers: { origin: 'http://localhost:5173' },
      payload: { trialRevisionId: SHARED_BOOK_ID, strategyDraftVersionId: SHARED_BOOK_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({ trialRevisionId: SHARED_BOOK_ID, strategyDraftVersionId: SHARED_BOOK_ID });
    expect(response.json()).toMatchObject({ workflowStatus: 'active_reading' });
  });

  it('streams interview deltas as SSE and closes with question_final', async () => {
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async *streamInterviewAnswer() {
          yield { type: 'ack_delta', chars: '好，' };
          yield { type: 'ack_delta', chars: '我记下了。' };
          yield { type: 'prompt_delta', chars: '下一个问题？' };
          yield { type: 'option_added', id: 'a', label: '甲' };
          yield { type: 'sufficiency', value: 60 };
          yield {
            type: 'question_final',
            question: {
              id: 'q2',
              acknowledgment: '好，我记下了。',
              prompt: '下一个问题？',
              options: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }],
              allowFreeText: true,
              profileDimension: 'reading_goals',
              sufficiency: 60,
            },
            ordinal: 2,
            maxQuestions: 7,
          };
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/interview/answers`,
      headers: { origin: 'http://localhost:5173' },
      payload: { questionId: 'q1', selectedOptionIds: ['a'], freeText: null, idempotencyKey: 'answer-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const body = response.body;
    expect(body).toContain('data: {"type":"ack_delta","chars":"好，"}');
    expect(body).toContain('data: {"type":"prompt_delta","chars":"下一个问题？"}');
    expect(body).toContain('data: {"type":"option_added","id":"a","label":"甲"}');
    expect(body).toContain('"type":"question_final"');
    expect(body).toContain('"id":"q2"');
    // The authoritative question is the last frame, after the deltas.
    expect(body.indexOf('ack_delta')).toBeLessThan(body.indexOf('question_final'));
  });

  it('surfaces a pre-stream validation failure as an HTTP status, not an SSE frame', async () => {
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        // Throws before the first yield — the route must convert this to an HTTP status.
        async *streamInterviewAnswer(): AsyncGenerator<never> {
          throw new UserBookError('问题已经更新，请刷新后继续', 409);
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/interview/answers`,
      headers: { origin: 'http://localhost:5173' },
      payload: { questionId: 'stale', selectedOptionIds: ['a'], freeText: null, idempotencyKey: 'answer-2' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: '问题已经更新，请刷新后继续' });
  });
});
