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
const BRIEFING = {
  bookIdentity: 'What it is',
  arc: 'How it goes',
  assumedKnowledge: 'What it assumes',
  readingAdvice: 'How to read it',
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
const interviewState = {
  sessionId: '33333333-4444-4555-8666-777777777777',
  status: 'active' as const,
  turnInProgress: false,
  questionCount: 1,
  maxQuestions: 7 as const,
  currentQuestion: null,
  sufficiency: null,
  answers: [],
};

const HIGHLIGHT_ID = '11111111-2222-3333-4444-555555555555';
const STRATEGY_VERSION_ID = '22222222-3333-4444-8555-666666666666';
const QA_RANGE = { start: { blockIndex: 1, offset: 0 }, end: { blockIndex: 1, offset: 5 } };
const HIGHLIGHT = {
  id: HIGHLIGHT_ID,
  sectionId: 'chapter-1',
  segment: 1,
  range: { start: { blockIndex: 1, offset: 0 }, end: { blockIndex: 1, offset: 5 } },
  note: null,
  quoteSnapshot: '第一段前五',
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
};

function fakeService(overrides: Partial<UserBookUserService> = {}): UserBookService {
  const bound = {
    async list() {
      return { books: [item] };
    },
    async listHighlights() {
      return { highlights: [HIGHLIGHT] };
    },
    async createHighlight(_userBookId: string, input: { sectionId: string; segment: number; range: typeof HIGHLIGHT.range; note?: string }) {
      return { highlight: { ...HIGHLIGHT, sectionId: input.sectionId, segment: input.segment, range: input.range, note: input.note ?? null } };
    },
    async updateHighlightNote(_userBookId: string, highlightId: string, input: { note: string | null }) {
      // Mirror the real handler: a blank/null note clears it (the route's schema coerces null → '').
      const note = input.note?.trim() ? input.note.trim() : null;
      return { highlight: { ...HIGHLIGHT, id: highlightId, note } };
    },
    async deleteHighlight(_userBookId: string, highlightId: string) {
      return { id: highlightId };
    },
    async workflow() {
      return { workflowStatus: 'active_reading', book: item, interview: null, strategy: null, trial: null };
    },
    async interviewState() {
      return interviewState;
    },
    async startInterview() {
      return interviewState;
    },
    async resumeInterview() {
      return interviewState;
    },
    async reader() {
      return {
        userBookId: USER_BOOK_ID,
        sharedBookId: SHARED_BOOK_ID,
        workflowStatus: 'active_reading',
        strategyVersionId: STRATEGY_VERSION_ID,
        strategyVersion: 1,
        briefing: BRIEFING,
        strategySummary: 'Strategy',
        enhancements: [],
        resumePosition: null,
        settings: READER_SETTINGS,
        readNodes: [],
        highlights: [],
      };
    },
    async reportReaderFocus() {
      return {
        userBookId: USER_BOOK_ID,
        sharedBookId: SHARED_BOOK_ID,
        workflowStatus: 'active_reading',
        strategyVersionId: STRATEGY_VERSION_ID,
        strategyVersion: 1,
        briefing: BRIEFING,
        strategySummary: 'Strategy',
        enhancements: [],
        resumePosition: null,
        settings: READER_SETTINGS,
        readNodes: [],
        highlights: [],
      };
    },
    async recordHeartbeat() {
      return { accepted: true };
    },
    async recordReadingActivitySlice() {
      return { accepted: true };
    },
    async getGlobalReadingStats() {
      return { todaySeconds: 600, weekSeconds: 3600, totalSeconds: 7200, streakDays: 3 };
    },
    async getBookReadingStats() {
      return {
        totalEffectiveSeconds: 1800,
        lastReadAt: '2026-07-14T00:00:00.000Z',
        progressPercent: 42,
        remainingCharacters: 35_100,
        remaining: { seconds: 5400, approximate: true },
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
            strategyVersionId: STRATEGY_VERSION_ID,
            strategyVersion: 1,
            briefing: BRIEFING,
            strategySummary: 'Strategy',
            enhancements: [
              { generationId: 'g1', strategyVersionId: STRATEGY_VERSION_ID, sectionId: 'chapter-3', segment: 1, status: 'queued', result: null },
            ],
            resumePosition: null,
            settings: READER_SETTINGS,
            readNodes: [],
            highlights: [],
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

  it('keeps interview reads separate from explicit start and resume commands', async () => {
    const calls: string[] = [];
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async interviewState() {
          calls.push('read');
          return interviewState;
        },
        async startInterview() {
          calls.push('start');
          return { ...interviewState, turnInProgress: true };
        },
        async resumeInterview() {
          calls.push('resume');
          return { ...interviewState, turnInProgress: true };
        },
      }),
    });

    const read = await app.inject({ method: 'GET', url: `/v1/user-books/${USER_BOOK_ID}/interview` });
    expect(read.statusCode).toBe(200);
    expect(read.json().turnInProgress).toBe(false);
    expect(calls).toEqual(['read']);

    const start = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/interview/start`,
      headers: { origin: 'http://localhost:5173' },
    });
    expect(start.statusCode).toBe(200);
    expect(start.json().turnInProgress).toBe(true);

    const resume = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/interview/resume`,
      headers: { origin: 'http://localhost:5173' },
    });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().turnInProgress).toBe(true);
    expect(calls).toEqual(['read', 'start', 'resume']);
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

  // §2.3 / §5.3: the position anchor carries the client's observation time so the server can merge
  // last-observed-wins. The route schema is the first gate — a full, well-formed anchor reaches the
  // service verbatim; a missing or non-ISO clientObservedAt is a 400 before any write.
  it('forwards a position carrying clientObservedAt to the service', async () => {
    let received: unknown;
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async reportReaderFocus(_userBookId, input) {
          received = input;
          return {
            userBookId: USER_BOOK_ID,
            sharedBookId: SHARED_BOOK_ID,
            workflowStatus: 'active_reading',
            strategyVersionId: STRATEGY_VERSION_ID,
            strategyVersion: 1,
            briefing: BRIEFING,
            strategySummary: 'Strategy',
            enhancements: [],
            resumePosition: null,
            settings: READER_SETTINGS,
            readNodes: [],
            highlights: [],
          };
        },
      }),
    });
    const position = { sectionId: 'chapter-3', segment: 1, blockIndex: 2, offset: 42, clientObservedAt: '2026-07-14T10:00:00.000Z' };
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/reader/focus`,
      headers: { origin: 'http://localhost:5173' },
      payload: { order: 12, position },
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({ order: 12, position });
  });

  it('rejects a reader focus position missing clientObservedAt', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/reader/focus`,
      headers: { origin: 'http://localhost:5173' },
      payload: { order: 12, position: { sectionId: 'c', segment: 1, blockIndex: 1, offset: 0 } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a reader focus position with a non-ISO clientObservedAt', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/reader/focus`,
      headers: { origin: 'http://localhost:5173' },
      payload: { order: 12, position: { sectionId: 'c', segment: 1, blockIndex: 1, offset: 0, clientObservedAt: 'yesterday' } },
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

  it('serves the reader bootstrap with a highlights array', async () => {
    const app = await buildApp();
    const reader = await app.inject({ method: 'GET', url: `/v1/user-books/${USER_BOOK_ID}/reader` });
    expect(reader.statusCode).toBe(200);
    expect(reader.json().highlights).toEqual([]);
  });

  it('creates, lists, edits the note on and deletes a highlight', async () => {
    const app = await buildApp();

    const created = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/highlights`,
      headers: { origin: 'http://localhost:5173' },
      payload: { sectionId: 'chapter-1', segment: 1, range: { start: { blockIndex: 1, offset: 0 }, end: { blockIndex: 1, offset: 5 } } },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().highlight).toMatchObject({ sectionId: 'chapter-1', note: null });

    const list = await app.inject({ method: 'GET', url: `/v1/user-books/${USER_BOOK_ID}/highlights` });
    expect(list.statusCode).toBe(200);
    expect(list.json().highlights).toHaveLength(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/v1/user-books/${USER_BOOK_ID}/highlights/${HIGHLIGHT_ID}`,
      headers: { origin: 'http://localhost:5173' },
      payload: { note: '我的想法' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().highlight).toMatchObject({ id: HIGHLIGHT_ID, note: '我的想法' });

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/v1/user-books/${USER_BOOK_ID}/highlights/${HIGHLIGHT_ID}`,
      headers: { origin: 'http://localhost:5173' },
      payload: { note: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().highlight.note).toBeNull();

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/user-books/${USER_BOOK_ID}/highlights/${HIGHLIGHT_ID}`,
      headers: { origin: 'http://localhost:5173' },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ id: HIGHLIGHT_ID });
  });

  it('rejects a highlight create with an out-of-bounds block index at the schema layer', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/highlights`,
      headers: { origin: 'http://localhost:5173' },
      // blockIndex minimum is 1 — a 0 is rejected before the handler runs.
      payload: { sectionId: 'chapter-1', segment: 1, range: { start: { blockIndex: 0, offset: 0 }, end: { blockIndex: 1, offset: 5 } } },
    });
    expect(response.statusCode).toBe(400);
  });

  it('surfaces an out-of-range highlight rejection from the service as 409', async () => {
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async createHighlight() {
          throw new UserBookError('划线范围超出节点', 409);
        },
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/highlights`,
      headers: { origin: 'http://localhost:5173' },
      payload: { sectionId: 'chapter-1', segment: 1, range: { start: { blockIndex: 9, offset: 0 }, end: { blockIndex: 9, offset: 5 } } },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: '划线范围超出节点' });
  });

  it('accepts a reading heartbeat and passes the parsed interval through', async () => {
    let received: unknown;
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async recordHeartbeat(_userBookId, input) {
          received = input;
          return { accepted: true };
        },
      }),
    });
    const payload = {
      clientIntervalId: 'interval-abcdef01',
      effectiveSeconds: 120,
      forwardSeconds: 90,
      forwardChars: 700,
      day: '2026-07-14',
      startedAt: '2026-07-14T09:00:00.000Z',
      at: '2026-07-14T09:02:00.000Z',
    };
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/reading-sessions/heartbeat`,
      headers: { origin: 'http://localhost:5173' },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    // The idempotency key + split counters reach the service verbatim (the GREATEST clamp that makes a
    // retry a no-op is DB-level, exercised by the integration round-trip).
    expect(received).toEqual(payload);
  });

  it('rejects a malformed heartbeat before the handler runs', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/reading-sessions/heartbeat`,
      headers: { origin: 'http://localhost:5173' },
      // forwardChars minimum is 0 — a negative is rejected by the schema.
      payload: {
        clientIntervalId: 'interval-abcdef01',
        effectiveSeconds: 60,
        forwardSeconds: 30,
        forwardChars: -1,
        day: '2026-07-14',
        startedAt: '2026-07-14T09:00:00.000Z',
        at: '2026-07-14T09:01:00.000Z',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('accepts a reading activity slice and passes it through', async () => {
    let received: unknown;
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async recordReadingActivitySlice(_userBookId, input) {
          received = input;
          return { accepted: true };
        },
      }),
    });
    const payload = {
      clientSessionId: 'session-abcdef01',
      sequence: 1,
      sliceStartedAt: '2026-07-14T09:00:00.000Z',
      sliceEndedAt: '2026-07-14T09:00:15.000Z',
      timezone: 'Asia/Shanghai',
      startPosition: { order: 1, sectionId: 'chapter-1', segment: 1, blockIndex: 1, offset: 0 },
      endPosition: { order: 1, sectionId: 'chapter-1', segment: 1, blockIndex: 1, offset: 120 },
      activityArea: 'original',
    };
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/reading-activity-slices`,
      headers: { origin: 'http://localhost:5173' },
      payload,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ accepted: true });
    expect(received).toEqual(payload);
  });

  it('rejects a malformed reading activity slice before the handler runs', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/reading-activity-slices`,
      headers: { origin: 'http://localhost:5173' },
      payload: {
        clientSessionId: 'session-abcdef01',
        sequence: 0,
        sliceStartedAt: '2026-07-14T09:00:00.000Z',
        sliceEndedAt: '2026-07-14T09:00:15.000Z',
        timezone: 'Asia/Shanghai',
        startPosition: { order: 1, sectionId: 'chapter-1', segment: 1, blockIndex: 1, offset: 0 },
        endPosition: { order: 1, sectionId: 'chapter-1', segment: 1, blockIndex: 1, offset: 120 },
        activityArea: 'scrolling_around',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('serves global reading stats and requires the client day window', async () => {
    const app = await buildApp();
    const ok = await app.inject({
      method: 'GET',
      url: `/v1/me/reading-stats?day=2026-07-14&weekStart=2026-07-13`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ todaySeconds: 600, weekSeconds: 3600, totalSeconds: 7200, streakDays: 3 });

    // day/weekStart are required and format-checked — a missing window is a 400, never a wrong-tz guess.
    const missing = await app.inject({ method: 'GET', url: `/v1/me/reading-stats` });
    expect(missing.statusCode).toBe(400);
  });

  it('serves per-book reading stats including the remaining-time estimate', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/user-books/${USER_BOOK_ID}/reading-stats`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      totalEffectiveSeconds: 1800,
      lastReadAt: '2026-07-14T00:00:00.000Z',
      progressPercent: 42,
      remainingCharacters: 35_100,
      remaining: { seconds: 5400, approximate: true },
    });
  });

  it('serves null remaining characters and time when the manifest has no character statistics', async () => {
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async getBookReadingStats() {
          return {
            totalEffectiveSeconds: 0,
            lastReadAt: null,
            progressPercent: 0,
            remainingCharacters: null,
            remaining: { seconds: null, approximate: true },
          };
        },
      }),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/user-books/${USER_BOOK_ID}/reading-stats`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      remainingCharacters: null,
      remaining: { seconds: null, approximate: true },
    });
  });
});

const QA_SESSION_ID = 'b7c3f1a2-1111-4a2b-8c3d-4e5f60718293';
const QA_PROPOSAL_ID = 'c8d4f2b3-2222-4b3c-9d4e-5f60718293a4';
const QA_REVISION_ID = 'd9e5a3c4-3333-4c4d-8e5f-60718293a4b5';

describe('问 AI QA endpoints', () => {
  it('streams a QA answer as SSE: session first, answer deltas, then done', async () => {
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async *streamQaAnswer() {
          yield { type: 'session', sessionId: QA_SESSION_ID, conversationVersion: 1 };
          yield { type: 'tool_started', toolCallId: 'call-1', toolName: 'search_book' };
          yield {
            type: 'tool_finished', toolCallId: 'call-1', toolName: 'search_book', succeeded: true,
          };
          yield { type: 'answer_delta', chars: '这段话的意思是' };
          yield { type: 'answer_delta', chars: '……' };
          yield { type: 'done', sessionId: QA_SESSION_ID, messageId: 'msg-1' };
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/qa`,
      headers: { origin: 'http://localhost:5173' },
      payload: {
        question: '这句话什么意思？',
        context: {
          anchor: 'highlight', precision: 'exact', nodeOrder: 1,
          sectionId: 'chap-1', segment: 1, range: QA_RANGE, quoteSnapshot: '存在先于本质',
        },
        idempotencyKey: 'qa-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    const body = response.body;
    expect(body).toContain(`data: {"type":"session","sessionId":"${QA_SESSION_ID}","conversationVersion":1}`);
    expect(body).toContain('data: {"type":"tool_started","toolCallId":"call-1","toolName":"search_book"}');
    expect(body).toContain('data: {"type":"tool_finished","toolCallId":"call-1","toolName":"search_book","succeeded":true}');
    expect(body).toContain('data: {"type":"answer_delta","chars":"这段话的意思是"}');
    expect(body).toContain('"type":"done"');
    // session precedes the answer, and the answer precedes done.
    expect(body.indexOf('"session"')).toBeLessThan(body.indexOf('answer_delta'));
    expect(body.indexOf('"session"')).toBeLessThan(body.indexOf('"tool_started"'));
    expect(body.indexOf('"tool_started"')).toBeLessThan(body.indexOf('"tool_finished"'));
    expect(body.indexOf('"tool_finished"')).toBeLessThan(body.indexOf('answer_delta'));
    expect(body.indexOf('answer_delta')).toBeLessThan(body.indexOf('"done"'));
  });

  it('surfaces a proposal event on the same stream', async () => {
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async *streamQaAnswer() {
          yield { type: 'session', sessionId: QA_SESSION_ID, conversationVersion: 1 };
          yield {
            type: 'proposal', proposalId: 'proposal-1', revisionId: 'revision-1', revision: 1,
            triggeringMessageId: 'msg-2', publicSummary: '建议加强对术语的解释', status: 'pending',
          };
          yield { type: 'answer_delta', chars: '好的' };
          yield { type: 'done', sessionId: QA_SESSION_ID, messageId: 'msg-2' };
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/qa`,
      headers: { origin: 'http://localhost:5173' },
      payload: {
        sessionId: QA_SESSION_ID,
        question: '能不能多讲讲术语？',
        idempotencyKey: 'qa-2',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"type":"proposal"');
    expect(response.body).toContain('"revisionId":"revision-1"');
  });

  it('surfaces a pre-stream failure as an HTTP status, not an SSE frame', async () => {
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async *streamQaAnswer(): AsyncGenerator<never> {
          throw new UserBookError('尚未开始阅读，暂不能提问', 409);
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/qa`,
      headers: { origin: 'http://localhost:5173' },
      payload: {
        question: '问题',
        context: {
          anchor: 'screen', precision: 'approximate', nodeOrder: 1,
          sectionId: 'chap-1', segment: 1, focus: { blockIndex: 1, offset: 0 },
          range: QA_RANGE, quoteSnapshot: '当前屏幕',
        },
        idempotencyKey: 'qa-3',
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: '尚未开始阅读，暂不能提问' });
  });

  it('rejects a QA request missing both question and context', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/qa`,
      headers: { origin: 'http://localhost:5173' },
      payload: { idempotencyKey: 'qa-4' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns a persisted QA transcript', async () => {
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async qaSession() {
          return {
            sessionId: QA_SESSION_ID,
            status: 'active',
            conversationVersion: 2,
            questionContext: {
              anchor: 'highlight', precision: 'exact', nodeOrder: 1,
              sectionId: 'chap-1', segment: 1, range: QA_RANGE, quoteSnapshot: '存在先于本质',
            },
            contextPrecision: 'exact',
            messages: [
              { id: 'm1', sequence: 1, role: 'user', kind: 'question', content: '这句话什么意思？', createdAt: '2026-07-15T00:00:00.000Z', proposalRevision: null },
              { id: 'm2', sequence: 2, role: 'assistant', kind: 'answer', content: '意思是……', createdAt: '2026-07-15T00:00:01.000Z', proposalRevision: null },
            ],
            proposal: null,
          };
        },
      }),
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/user-books/${USER_BOOK_ID}/qa/${QA_SESSION_ID}`,
      headers: { origin: 'http://localhost:5173' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      sessionId: QA_SESSION_ID,
      status: 'active',
      conversationVersion: 2,
      messages: [{ id: 'm1', kind: 'question' }, { id: 'm2', kind: 'answer' }],
      proposal: null,
    });
  });

  it('lists resumable QA sessions', async () => {
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async listQaSessions() {
          return {
            sessions: [{
              sessionId: QA_SESSION_ID,
              status: 'active',
              question: '这句话什么意思？',
              updatedAt: '2026-07-15T00:00:01.000Z',
              messageCount: 2,
            }],
            nextCursor: null,
          };
        },
      }),
    });
    const response = await app.inject({
      method: 'GET',
      url: `/v1/user-books/${USER_BOOK_ID}/qa?limit=10`,
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().sessions[0]).toMatchObject({ sessionId: QA_SESSION_ID, messageCount: 2 });
  });

  it('confirms a proposal revision through the guarded command route', async () => {
    let received: unknown;
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async confirmProposal(_userBookId, proposalId, input) {
          received = { proposalId, input };
          return {
            proposalId,
            revisionId: input.revisionId,
            status: 'confirmed',
            resultingStrategyVersionId: STRATEGY_VERSION_ID,
          };
        },
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/qa/proposals/${QA_PROPOSAL_ID}/confirm`,
      headers: { origin: 'http://localhost:5173' },
      payload: { revisionId: QA_REVISION_ID, idempotencyKey: 'confirm-1' },
    });
    expect(response.statusCode).toBe(200);
    expect(received).toEqual({
      proposalId: QA_PROPOSAL_ID,
      input: { revisionId: QA_REVISION_ID, idempotencyKey: 'confirm-1' },
    });
    expect(response.json()).toMatchObject({ status: 'confirmed', resultingStrategyVersionId: STRATEGY_VERSION_ID });
  });
});
