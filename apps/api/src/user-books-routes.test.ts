import { describe, expect, it } from 'vitest';
import type { StrategyRevisionStreamEvent, TrialSelectionStreamEvent } from '@readtailor/contracts';
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
const detail = {
  book: item,
  currentInterviewSessionId: null,
  currentBookReaderProfileVersionId: null,
  currentStrategyDraftVersionId: null,
  currentStrategyVersionId: '22222222-3333-4444-8555-666666666666',
  currentTrialRevisionId: null,
  adjustmentCount: 0,
  deletedAt: null,
  purgeAfter: null,
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
};

function strategyReview(draftId = STRATEGY_DRAFT_ID) {
  return {
    userBookId: USER_BOOK_ID,
    workflowStatus: 'strategy_review' as const,
    draft: {
      id: draftId,
      version: 2,
      status: 'draft' as const,
      readingBriefing: BRIEFING,
      userFacingSummary: 'Strategy',
      strategy: {
        goals: ['goal'],
        expressionPrinciples: ['plain'],
        guide: { enabled: true, objectives: ['orient'] },
        annotations: { enabled: true, focuses: ['terms'], exclusions: [] },
        afterReading: { enabled: true, objectives: ['recap'] },
        trialCandidates: [1, 2, 3].map((segment) => ({ sectionId: 'chapter-1', segment, reason: `reason-${segment}` })),
      },
      createdAt: '2026-07-14T00:00:00.000Z',
      approvedForTrialAt: null,
    },
    trialCandidatePreviews: [1, 2, 3].map((segment) => ({
      ordinal: segment,
      sectionId: 'chapter-1',
      segment,
      chapterPath: ['Chapter 1'],
      reason: `reason-${segment}`,
    })),
    adjustmentCount: 1,
    adjustmentLimit: 5,
    canAdjust: true,
  };
}

const HIGHLIGHT_ID = '11111111-2222-3333-4444-555555555555';
const STRATEGY_VERSION_ID = '22222222-3333-4444-8555-666666666666';
const OPERATION_ID = '44444444-5555-4666-8777-888888888888';
const STRATEGY_DRAFT_ID = '55555555-6666-4777-8888-999999999999';
const TRIAL_REVISION_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
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
    async detail() {
      return detail;
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
  it('serves the user shelf, read-only detail and reader bootstrap', async () => {
    const app = await buildApp();

    const shelf = await app.inject({ method: 'GET', url: '/v1/user-books' });
    expect(shelf.statusCode).toBe(200);
    expect(shelf.json()).toEqual({ books: [item] });

    const detailResponse = await app.inject({ method: 'GET', url: `/v1/user-books/${USER_BOOK_ID}` });
    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json().book.workflowStatus).toBe('active_reading');

    const removedWorkflow = await app.inject({ method: 'GET', url: `/v1/user-books/${USER_BOOK_ID}/workflow` });
    expect(removedWorkflow.statusCode).toBe(404);

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

  it('rejects malformed reading setup commands before calling the service', async () => {
    let calls = 0;
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async *streamStrategyFeedback() { calls += 1; throw new Error('must not run'); },
        async *streamApproveStrategy() { calls += 1; throw new Error('must not run'); },
        async *streamTrialFeedback() { calls += 1; throw new Error('must not run'); },
      }),
    });
    const requests = [
      app.inject({
        method: 'POST',
        url: `/v1/user-books/${USER_BOOK_ID}/strategy/feedback/stream`,
        headers: { origin: 'http://localhost:5173' },
        payload: { strategyDraftVersionId: 'not-a-uuid', feedback: 'clearer', idempotencyKey: 'command-1' },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/user-books/${USER_BOOK_ID}/strategy/feedback/stream`,
        headers: { origin: 'http://localhost:5173' },
        payload: { strategyDraftVersionId: STRATEGY_DRAFT_ID, feedback: '   ', idempotencyKey: 'command-2' },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/user-books/${USER_BOOK_ID}/strategy/approve/stream`,
        headers: { origin: 'http://localhost:5173' },
        payload: { strategyDraftVersionId: STRATEGY_DRAFT_ID, idempotencyKey: '   ' },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/user-books/${USER_BOOK_ID}/trial/feedback/stream`,
        headers: { origin: 'http://localhost:5173' },
        payload: { trialRevisionId: 'not-a-uuid', feedback: 'clearer', idempotencyKey: 'command-3' },
      }),
    ];

    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.statusCode)).toEqual([400, 400, 400, 400]);
    expect(calls).toBe(0);
  });

  it.each([
    ['/strategy/feedback', { strategyDraftVersionId: STRATEGY_DRAFT_ID, feedback: 'clearer', idempotencyKey: 'command-1' }],
    ['/strategy/approve', { strategyDraftVersionId: STRATEGY_DRAFT_ID, idempotencyKey: 'command-2' }],
    ['/trial/feedback', { trialRevisionId: TRIAL_REVISION_ID, feedback: 'clearer', idempotencyKey: 'command-3' }],
  ])('does not expose the retired synchronous endpoint %s', async (path, payload) => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}${path}`,
      headers: { origin: 'http://localhost:5173' },
      payload,
    });
    expect(response.statusCode).toBe(404);
  });

  it('reads exact strategy and trial versions by pointer', async () => {
    const calls: string[] = [];
    const strategy = {
      userBookId: USER_BOOK_ID,
      workflowStatus: 'strategy_review' as const,
      draft: {
        id: STRATEGY_DRAFT_ID,
        version: 2,
        status: 'draft' as const,
        readingBriefing: BRIEFING,
        userFacingSummary: 'Strategy',
        strategy: {
          goals: ['goal'],
          expressionPrinciples: ['plain'],
          guide: { enabled: true, objectives: ['orient'] },
          annotations: { enabled: true, focuses: ['terms'], exclusions: [] },
          afterReading: { enabled: true, objectives: ['recap'] },
          trialCandidates: [1, 2, 3].map((segment) => ({ sectionId: 'chapter-1', segment, reason: `reason-${segment}` })),
        },
        createdAt: '2026-07-14T00:00:00.000Z',
        approvedForTrialAt: null,
      },
      trialCandidatePreviews: [1, 2, 3].map((segment) => ({
        ordinal: segment,
        sectionId: 'chapter-1',
        segment,
        chapterPath: ['Chapter 1'],
        reason: `reason-${segment}`,
      })),
      adjustmentCount: 1,
      adjustmentLimit: 5,
      canAdjust: true,
    };
    const trial = {
      userBookId: USER_BOOK_ID,
      workflowStatus: 'trial_generating' as const,
      trialRevisionId: TRIAL_REVISION_ID,
      revision: 3,
      status: 'generating' as const,
      strategyDraftVersionId: STRATEGY_DRAFT_ID,
      segments: [1, 2, 3].map((ordinal) => ({
        id: `${ordinal}1111111-2222-4333-8444-555555555555`,
        ordinal,
        sectionId: 'chapter-1',
        segment: ordinal,
        range: { start: { blockIndex: 1, offset: 0 }, end: { blockIndex: 1, offset: 5 } },
        chapterPath: ['Chapter 1'],
        originalHtml: '<p>text</p>',
        selectionReason: `reason-${ordinal}`,
        status: 'pending' as const,
        result: null,
        viewedAt: null,
      })),
      adjustmentCount: 1,
      adjustmentLimit: 5,
      canAdjust: true,
      canAdopt: false,
    };
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async strategyStateByDraftId(_userBookId, draftId) {
          calls.push(`strategy:${draftId}`);
          return strategy;
        },
        async trialStateByRevisionId(_userBookId, revisionId) {
          calls.push(`trial:${revisionId}`);
          return trial;
        },
      }),
    });

    const strategyResponse = await app.inject({
      method: 'GET',
      url: `/v1/user-books/${USER_BOOK_ID}/strategy/versions/${STRATEGY_DRAFT_ID}`,
    });
    const trialResponse = await app.inject({
      method: 'GET',
      url: `/v1/user-books/${USER_BOOK_ID}/trial/revisions/${TRIAL_REVISION_ID}`,
    });
    expect(strategyResponse.statusCode).toBe(200);
    expect(trialResponse.statusCode).toBe(200);
    expect(strategyResponse.headers['cache-control']).toBe('private, no-store');
    expect(trialResponse.headers['cache-control']).toBe('private, no-store');
    expect(calls).toEqual([`strategy:${STRATEGY_DRAFT_ID}`, `trial:${TRIAL_REVISION_ID}`]);
  });

  it('exposes current, detail and resume operation routes', async () => {
    const calls: string[] = [];
    const operation = {
      operationId: OPERATION_ID,
      operationAttempt: 1,
      kind: 'strategy_revision' as const,
      source: 'strategy_feedback' as const,
      status: 'pending' as const,
      baseDraftId: STRATEGY_DRAFT_ID,
      baseTrialRevisionId: null,
      resultDraftId: null,
      resultTrialRevisionId: null,
      canResume: true,
      errorSummary: null,
      recoverableInput: { feedback: 'make it clearer' },
    };
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async currentReadingSetupOperation() {
          calls.push('current');
          return operation;
        },
        async readingSetupOperation(_userBookId, operationId) {
          calls.push(`detail:${operationId}`);
          return operation;
        },
        async resumeReadingSetupOperation(_userBookId, operationId) {
          calls.push(`resume:${operationId}`);
          return { ...operation, status: 'running' as const, canResume: false };
        },
      }),
    });
    const current = await app.inject({
      method: 'GET',
      url: `/v1/user-books/${USER_BOOK_ID}/reading-setup-operation/current`,
    });
    const detailResponse = await app.inject({
      method: 'GET',
      url: `/v1/user-books/${USER_BOOK_ID}/reading-setup-operation/${OPERATION_ID}`,
    });
    const resumed = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/reading-setup-operation/${OPERATION_ID}/resume`,
      headers: { origin: 'http://localhost:5173' },
      payload: {},
    });
    expect(current.statusCode).toBe(200);
    expect(detailResponse.statusCode).toBe(200);
    expect(resumed.statusCode).toBe(200);
    expect(current.headers['cache-control']).toBe('private, no-store');
    expect(detailResponse.headers['cache-control']).toBe('private, no-store');
    expect(calls).toEqual(['current', `detail:${OPERATION_ID}`, `resume:${OPERATION_ID}`]);
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

  it('streams strategy and trial feedback through the shared revision contract', async () => {
    const streamId = OPERATION_ID;
    const createEvents = async function* (
      source: 'strategy_feedback' | 'trial_feedback',
    ): AsyncGenerator<StrategyRevisionStreamEvent> {
      yield {
        userBookId: USER_BOOK_ID,
        operationId: streamId,
        operationAttempt: 1,
        sequence: 1,
        speculativeEpoch: 1,
        type: 'revision_started' as const,
        source,
        baseDraftId: STRATEGY_DRAFT_ID,
        baseTrialRevisionId: source === 'trial_feedback' ? TRIAL_REVISION_ID : null,
      } as StrategyRevisionStreamEvent;
      yield {
        userBookId: USER_BOOK_ID,
        operationId: streamId,
        operationAttempt: 1,
        sequence: 2,
        speculativeEpoch: 1,
        type: 'strategy_delta' as const,
        chars: 'New strategy',
      };
      yield {
        userBookId: USER_BOOK_ID,
        operationId: streamId,
        operationAttempt: 1,
        sequence: 3,
        type: 'revision_final' as const,
        strategy: strategyReview(),
      };
    };
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        streamStrategyFeedback() {
          return createEvents('strategy_feedback');
        },
        streamTrialFeedback() {
          return createEvents('trial_feedback');
        },
      }),
    });

    const [strategy, trial] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/v1/user-books/${USER_BOOK_ID}/strategy/feedback/stream`,
        headers: { origin: 'http://localhost:5173' },
        payload: { strategyDraftVersionId: STRATEGY_DRAFT_ID, feedback: 'shorter', idempotencyKey: 'command-1' },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/user-books/${USER_BOOK_ID}/trial/feedback/stream`,
        headers: { origin: 'http://localhost:5173' },
        payload: { trialRevisionId: TRIAL_REVISION_ID, feedback: 'fewer notes', idempotencyKey: 'command-2' },
      }),
    ]);

    for (const response of [strategy, trial]) {
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-accel-buffering']).toBe('no');
      expect(response.body.indexOf('revision_started')).toBeLessThan(response.body.indexOf('revision_final'));
    }
    expect(strategy.body).toContain('"source":"strategy_feedback"');
    expect(trial.body).toContain('"source":"trial_feedback"');
  });

  it('streams strategy approval into fixed trial slots and a final revision', async () => {
    const trial = {
      userBookId: USER_BOOK_ID,
      workflowStatus: 'trial_generating' as const,
      trialRevisionId: TRIAL_REVISION_ID,
      revision: 1,
      status: 'generating' as const,
      strategyDraftVersionId: STRATEGY_DRAFT_ID,
      segments: [1, 2, 3].map((ordinal) => ({
        id: `${ordinal}1111111-2222-4333-8444-555555555555`,
        ordinal,
        sectionId: 'chapter-1',
        segment: ordinal,
        range: { start: { blockIndex: 1, offset: 0 }, end: { blockIndex: 1, offset: 5 } },
        chapterPath: ['Chapter 1'],
        originalHtml: '<p>text</p>',
        selectionReason: `reason-${ordinal}`,
        status: 'pending' as const,
        result: null,
        viewedAt: null,
      })),
      adjustmentCount: 0,
      adjustmentLimit: 5,
      canAdjust: false,
      canAdopt: false,
    };
    const events = async function* (): AsyncGenerator<TrialSelectionStreamEvent> {
      yield {
        userBookId: USER_BOOK_ID,
        operationId: OPERATION_ID,
        operationAttempt: 1,
        sequence: 1,
        type: 'selection_started',
        speculativeEpoch: 1,
        draftId: STRATEGY_DRAFT_ID,
        slots: [
          { ordinal: 1, tag: 'threshold' },
          { ordinal: 2, tag: 'typical' },
          { ordinal: 3, tag: 'hardest' },
        ],
      };
      yield {
        userBookId: USER_BOOK_ID,
        operationId: OPERATION_ID,
        operationAttempt: 1,
        sequence: 2,
        type: 'trial_created',
        draftId: STRATEGY_DRAFT_ID,
        trial,
      } as TrialSelectionStreamEvent;
    };
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        streamApproveStrategy() {
          return events();
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/strategy/approve/stream`,
      headers: { origin: 'http://localhost:5173' },
      payload: { strategyDraftVersionId: STRATEGY_DRAFT_ID, idempotencyKey: 'approve-stream-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-accel-buffering']).toBe('no');
    expect(response.body.indexOf('selection_started')).toBeLessThan(response.body.indexOf('trial_created'));
    expect(response.body).toContain('"ordinal":1,"tag":"threshold"');
    expect(response.body).toContain(`"trialRevisionId":"${TRIAL_REVISION_ID}"`);
  });

  it('keeps approval stream validation errors as pre-stream HTTP responses', async () => {
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async *streamApproveStrategy() {
          throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
        },
      }),
    });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/strategy/approve/stream`,
      headers: { origin: 'http://localhost:5173' },
      payload: { strategyDraftVersionId: STRATEGY_DRAFT_ID, idempotencyKey: 'approve-stream-2' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: '处理方式已经更新，请刷新后继续' });
  });

  it('streams interview deltas as SSE and closes with question_final', async () => {
    const streamId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async *streamInterviewAnswer() {
          yield { userBookId: USER_BOOK_ID, streamId, sequence: 1, speculativeEpoch: 1, type: 'ack_delta', chars: '好，' };
          yield { userBookId: USER_BOOK_ID, streamId, sequence: 2, speculativeEpoch: 1, type: 'ack_delta', chars: '我记下了。' };
          yield { userBookId: USER_BOOK_ID, streamId, sequence: 3, speculativeEpoch: 1, type: 'prompt_delta', chars: '下一个问题？' };
          yield { userBookId: USER_BOOK_ID, streamId, sequence: 4, speculativeEpoch: 1, type: 'option_added', id: 'a', label: '甲' };
          yield { userBookId: USER_BOOK_ID, streamId, sequence: 5, speculativeEpoch: 1, type: 'sufficiency', value: 60 };
          yield {
            userBookId: USER_BOOK_ID,
            streamId,
            sequence: 6,
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
    expect(body).toContain('"type":"ack_delta"');
    expect(body).toContain('"chars":"好，"');
    expect(body).toContain('"type":"prompt_delta"');
    expect(body).toContain('"type":"option_added"');
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

  it('streams an expired interview turn through the additive resume endpoint', async () => {
    const streamId = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
    const app = await buildApiApp(config, {
      auth: fakeAuth,
      userBooks: fakeService({
        async *streamResumeInterview() {
          yield {
            userBookId: USER_BOOK_ID,
            streamId,
            sequence: 1,
            speculativeEpoch: 1,
            type: 'draft_started',
            conversationVersion: 6,
          };
          yield {
            userBookId: USER_BOOK_ID,
            streamId,
            sequence: 2,
            type: 'done',
            workflowStatus: 'strategy_review',
          };
        },
      }),
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/user-books/${USER_BOOK_ID}/interview/resume/stream`,
      headers: { origin: 'http://localhost:5173' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.body).toContain('"type":"draft_started"');
    expect(response.body).toContain('"workflowStatus":"strategy_review"');
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
