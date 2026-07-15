import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveStrategyForTrial,
  getCurrentReadingSetupOperation,
  getReadingSetupOperation,
  getStrategy,
  getTrial,
  getUserBook,
  resumeInterview,
  resumeReadingSetupOperation,
  startInterview,
  submitStrategyFeedback,
  submitTrialFeedback,
} from './api';
import { userBookQueryKeys } from './queryKeys';

afterEach(() => {
  vi.unstubAllGlobals();
});

function interviewResponse(turnInProgress: boolean): Response {
  return Response.json({
    sessionId: 'session-1',
    status: 'active',
    turnInProgress,
    questionCount: 1,
    maxQuestions: 7,
    currentQuestion: null,
    sufficiency: null,
    answers: [],
  });
}

describe('interview lifecycle commands', () => {
  it.each([
    ['start', startInterview],
    ['resume', resumeInterview],
  ] as const)('posts the explicit %s command without an idempotency payload', async (command, request) => {
    const fetchMock = vi.fn().mockResolvedValue(interviewResponse(true));
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('book/1')).resolves.toMatchObject({
      status: 'generating',
      turnInProgress: true,
      canResume: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`/v1/user-books/book%2F1/interview/${command}$`)),
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: '{}',
      }),
    );
  });

  it('marks an unleased pending turn as resumable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(interviewResponse(false)));

    await expect(resumeInterview('book-1')).resolves.toMatchObject({
      status: 'generating',
      turnInProgress: false,
      canResume: true,
    });
  });
});

describe('user book detail', () => {
  it('reads the book and current setup pointers from the detail endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      book: {
        id: 'book/1',
        sharedBookId: 'shared-1',
        sharedBookStatus: 'ready',
        workflowStatus: 'interviewing',
        title: 'Book',
        authors: ['Author'],
        coverPath: null,
        errorSummary: null,
        failureType: null,
        progress: null,
        lastActivityAt: '2026-07-15T00:00:00.000Z',
      },
      currentStrategyDraftVersionId: 'draft-1',
      currentStrategyVersionId: null,
      currentTrialRevisionId: 'trial-1',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getUserBook('book/1')).resolves.toMatchObject({
      id: 'book/1',
      workflowStatus: 'interviewing',
      currentStrategyDraftVersionId: 'draft-1',
      currentStrategyVersionId: null,
      currentTrialRevisionId: 'trial-1',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/user-books\/book%2F1$/),
      { credentials: 'include' },
    );
  });
});

const briefing = {
  coreQuestion: '核心问题',
  knowledgeMap: '知识地图',
  difficultyWarnings: '难点',
  readingApproach: '阅读方式',
};

function strategyResponse(draftId = 'draft-1') {
  return {
    userBookId: 'book-1',
    workflowStatus: 'strategy_review',
    draft: {
      id: draftId,
      version: 1,
      status: 'draft',
      readingBriefing: briefing,
      userFacingSummary: '处理方式',
      strategy: {},
      createdAt: '2026-07-15T00:00:00.000Z',
      approvedForTrialAt: null,
    },
    trialCandidatePreviews: [1, 2, 3].map((ordinal) => ({
      ordinal,
      sectionId: `section-${ordinal}`,
      segment: ordinal,
      chapterPath: [`章节 ${ordinal}`],
      reason: `原因 ${ordinal}`,
    })),
    adjustmentCount: 0,
    adjustmentLimit: 5,
    canAdjust: true,
  };
}

function trialResponse(trialRevisionId = 'trial-1') {
  return {
    userBookId: 'book-1',
    workflowStatus: 'trial_generating',
    trialRevisionId,
    revision: 1,
    status: 'generating',
    strategyDraftVersionId: 'draft-1',
    segments: [1, 2, 3].map((ordinal) => ({
      id: `segment-${ordinal}`,
      ordinal,
      sectionId: `section-${ordinal}`,
      segment: ordinal,
      range: { start: { blockIndex: 1, offset: 0 }, end: { blockIndex: 1, offset: 10 } },
      chapterPath: [`章节 ${ordinal}`],
      originalHtml: `<p>原文 ${ordinal}</p>`,
      selectionReason: `原因 ${ordinal}`,
      viewedAt: null,
      status: 'pending',
      result: null,
    })),
    adjustmentCount: 0,
    adjustmentLimit: 5,
    canAdjust: true,
    canAdopt: false,
  };
}

describe('versioned setup resources', () => {
  it('uses exact strategy and trial revision endpoints and preserves preview/segment state', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(strategyResponse()))
      .mockResolvedValueOnce(Response.json(trialResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const strategy = await getStrategy('book/1', 'draft/1');
    expect(strategy.draftId).toBe('draft-1');
    expect(strategy.trialCandidatePreviews[0]).toMatchObject({ ordinal: 1, sectionId: 'section-1' });

    const trial = await getTrial('book/1', 'trial/1');
    expect(trial.revisionId).toBe('trial-1');
    expect(trial.samples[0]).toMatchObject({
      status: 'pending',
      tailoredContent: null,
      selectionReason: '原因 1',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/strategy\/versions\/draft%2F1$/);
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(/\/trial\/revisions\/trial%2F1$/);
  });

  it('builds stable, version-specific query keys', () => {
    expect(userBookQueryKeys.strategy('book-1', 'draft-1')).toEqual([
      'user-book', 'book-1', 'strategy', 'draft-1',
    ]);
    expect(userBookQueryKeys.trial('book-1', 'trial-1')).toEqual([
      'user-book', 'book-1', 'trial', 'trial-1',
    ]);
    expect(userBookQueryKeys.readingSetupOperation('book-1', 'operation-1')).toEqual([
      'user-book', 'book-1', 'reading-setup-operation', 'operation-1',
    ]);
  });
});

describe('reading setup command idempotency', () => {
  it('posts caller-owned keys for strategy feedback and trial feedback', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(strategyResponse('draft-2')))
      .mockResolvedValueOnce(Response.json(strategyResponse('draft-3')));
    vi.stubGlobal('fetch', fetchMock);

    await submitStrategyFeedback('book-1', 'draft-1', '再简短一些', 'strategy-command-1');
    await submitTrialFeedback('book-1', 'trial-1', '注释少一些', 'trial-command-1');

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      strategyDraftVersionId: 'draft-1',
      feedback: '再简短一些',
      idempotencyKey: 'strategy-command-1',
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      trialRevisionId: 'trial-1',
      feedback: '注释少一些',
      idempotencyKey: 'trial-command-1',
    });
  });

  it('posts the caller-owned approve key and fetches the returned exact revision', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ trialRevisionId: 'trial/2' }))
      .mockResolvedValueOnce(Response.json(trialResponse('trial/2')));
    vi.stubGlobal('fetch', fetchMock);

    await approveStrategyForTrial('book-1', 'draft-1', 'approve-command-1');

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      strategyDraftVersionId: 'draft-1',
      idempotencyKey: 'approve-command-1',
    });
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(/\/trial\/revisions\/trial%2F2$/);
  });
});

describe('reading setup operation helpers', () => {
  it('addresses current, exact, and resume operation endpoints', async () => {
    const operation = { operationId: 'operation-1', status: 'running' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json(operation))
      .mockResolvedValueOnce(Response.json(operation))
      .mockResolvedValueOnce(Response.json(operation));
    vi.stubGlobal('fetch', fetchMock);

    await getCurrentReadingSetupOperation('book/1');
    await getReadingSetupOperation('book/1', 'operation/1');
    await resumeReadingSetupOperation('book/1', 'operation/1');

    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/reading-setup-operation\/current$/);
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(/\/reading-setup-operation\/operation%2F1$/);
    expect(fetchMock.mock.calls[2]).toEqual([
      expect.stringMatching(/\/reading-setup-operation\/operation%2F1\/resume$/),
      expect.objectContaining({ method: 'POST', body: '{}' }),
    ]);
  });
});
