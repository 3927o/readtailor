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
  streamApproveStrategyForTrial,
  streamStrategyFeedback,
  streamTrialFeedback,
  streamResumeInterview,
  type StrategyRevisionClientEvent,
  type TrialSelectionClientEvent,
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
  bookIdentity: '核心问题',
  arc: '知识地图',
  assumedKnowledge: '难点',
  readingAdvice: '阅读方式',
};

describe('interview progressive stream', () => {
  it('decodes chunked resume events and maps draft_final to the Web snapshot', async () => {
    const streamId = '10000000-0000-0000-0000-000000000002';
    const frames = [
      { userBookId: '10000000-0000-0000-0000-000000000001', streamId, sequence: 1, speculativeEpoch: 1, type: 'draft_started', conversationVersion: 6 },
      { userBookId: '10000000-0000-0000-0000-000000000001', streamId, sequence: 2, speculativeEpoch: 1, type: 'strategy_delta', chars: '逐步形成' },
      { userBookId: '10000000-0000-0000-0000-000000000001', streamId, sequence: 3, type: 'draft_final', strategy: strategyResponse('draft-2') },
      { userBookId: '10000000-0000-0000-0000-000000000001', streamId, sequence: 4, type: 'done', workflowStatus: 'strategy_review' },
    ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join('');
    const bytes = new TextEncoder().encode(frames);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 37));
        controller.enqueue(bytes.slice(37));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const events: Array<{ type: string; strategy?: { draftId: string } }> = [];

    await streamResumeInterview('book/1', { onEvent: (event) => events.push(event) });

    expect(events.map((event) => event.type)).toEqual(['draft_started', 'strategy_delta', 'draft_final', 'done']);
    expect(events[2]?.strategy?.draftId).toBe('draft-2');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/interview\/resume\/stream$/),
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });
});

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

  it('degrades an inconsistent ready segment without tailored content to failed', async () => {
    const raw = trialResponse();
    raw.segments[0] = { ...raw.segments[0]!, status: 'ready', result: null };
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(raw)));

    const snapshot = await getTrial('book-1', 'trial-1');

    expect(snapshot.samples[0]).toMatchObject({ status: 'failed', tailoredContent: null });
    expect(error).toHaveBeenCalledWith(
      '[trial] ready segment is missing tailored content',
      { segmentId: 'segment-1' },
    );
    error.mockRestore();
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

describe('strategy revision streams', () => {
  it.each([
    ['strategy', streamStrategyFeedback, ['book-1', 'draft-1', '再短一些', 'command-1']],
    ['trial', streamTrialFeedback, ['book-1', 'trial-1', '注释少一些', 'command-2']],
  ] as const)('maps %s feedback final snapshots and preserves caller keys', async (_source, request, args) => {
    const envelope = {
      userBookId: '10000000-0000-0000-0000-000000000001',
      operationId: '10000000-0000-0000-0000-000000000002',
      operationAttempt: 1,
    };
    const frames = [
      { ...envelope, sequence: 1, speculativeEpoch: 1, type: 'strategy_delta', chars: '新方式' },
      { ...envelope, sequence: 2, type: 'revision_final', strategy: strategyResponse('draft-2') },
    ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join('');
    const fetchMock = vi.fn().mockResolvedValue(new Response(frames, {
      headers: { 'content-type': 'text/event-stream' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const events: Array<{ type: string; strategy?: { draftId: string } }> = [];

    await request(args[0], args[1], args[2], args[3], {
      onEvent: (event: StrategyRevisionClientEvent) => events.push(event),
    });

    expect(events.map((event) => event.type)).toEqual(['strategy_delta', 'revision_final']);
    expect(events[1]?.strategy?.draftId).toBe('draft-2');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      idempotencyKey: args[3],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/feedback/stream');
  });
});

describe('trial selection streams', () => {
  it('maps provisional fragments and the authoritative final trial while preserving the caller key', async () => {
    const envelope = {
      userBookId: '10000000-0000-0000-0000-000000000001',
      operationId: '10000000-0000-0000-0000-000000000002',
      operationAttempt: 1,
    };
    const frames = [
      {
        ...envelope,
        sequence: 1,
        speculativeEpoch: 1,
        type: 'fragment_selected',
        draftId: 'draft-1',
        sample: {
          ordinal: 1,
          tag: 'threshold',
          sectionId: 'section-1',
          segment: 1,
          range: { start: { blockIndex: 1, offset: 0 }, end: { blockIndex: 1, offset: 10 } },
          chapterPath: ['第一章'],
          originalHtml: '<p>原文</p>',
          selectionReason: '进入门槛',
        },
      },
      {
        ...envelope,
        sequence: 2,
        type: 'trial_created',
        draftId: 'draft-1',
        trial: trialResponse('trial-2'),
      },
    ].map((item) => `data: ${JSON.stringify(item)}\n\n`).join('');
    const encoder = new TextEncoder();
    const response = new Response(new ReadableStream({
      start(controller) {
        const split = Math.floor(frames.length / 2);
        controller.enqueue(encoder.encode(frames.slice(0, split)));
        controller.enqueue(encoder.encode(frames.slice(split)));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
    const events: TrialSelectionClientEvent[] = [];

    await streamApproveStrategyForTrial('book-1', 'draft-1', 'approve-command-1', {
      onEvent: (event) => events.push(event),
    });

    expect(events.map((event) => event.type)).toEqual(['fragment_selected', 'trial_created']);
    expect(events[0]).toMatchObject({ type: 'fragment_selected', sample: { ordinal: 1 } });
    expect(events[1]).toMatchObject({ type: 'trial_created', trial: { revisionId: 'trial-2' } });
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/strategy\/approve\/stream$/);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      strategyDraftVersionId: 'draft-1',
      idempotencyKey: 'approve-command-1',
    });
  });

  it('treats a stream without a terminal event as recoverable transport failure', async () => {
    const frame = `data: ${JSON.stringify({
      userBookId: '10000000-0000-0000-0000-000000000001',
      operationId: '10000000-0000-0000-0000-000000000002',
      operationAttempt: 1,
      sequence: 1,
      speculativeEpoch: 1,
      type: 'selection_started',
      draftId: 'draft-1',
      slots: [
        { ordinal: 1, tag: 'threshold' },
        { ordinal: 2, tag: 'typical' },
        { ordinal: 3, tag: 'hardest' },
      ],
    })}\n\n`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(frame, {
      headers: { 'content-type': 'text/event-stream' },
    })));

    await expect(streamApproveStrategyForTrial('book-1', 'draft-1', 'command-1', {
      onEvent: () => {},
    })).rejects.toMatchObject({ status: 0 });
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
