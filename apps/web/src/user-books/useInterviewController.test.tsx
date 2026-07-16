// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBookDetail } from './api/http';
import type { InterviewSnapshot } from './api/interview';
import type { StrategySnapshot } from './api/strategy';
import { ApiError } from './apiError';
import { InterviewPage } from './InterviewPage';
import { userBookQueryKeys } from './queryKeys';
import { useInterviewController } from './useInterviewController';

const apiMocks = vi.hoisted(() => ({
  getInterview: vi.fn(),
  startInterview: vi.fn(),
  streamAnswer: vi.fn(),
  streamResume: vi.fn(),
}));

vi.mock('./api/interview', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/interview')>();
  return {
    ...actual,
    getInterview: apiMocks.getInterview,
    startInterview: apiMocks.startInterview,
    streamInterviewAnswer: apiMocks.streamAnswer,
    streamResumeInterview: apiMocks.streamResume,
  };
});

vi.mock('./components', () => ({
  AssistanceContent: ({ content }: { content: string }) => <div>{content}</div>,
  AdjustmentForm: ({ disabled = false }: { disabled?: boolean }) => (
    <textarea aria-label="策略反馈" disabled={disabled} />
  ),
  BackToShelf: () => <a href="/">返回书架</a>,
  BriefCard: ({ briefing }: { briefing: Record<string, string> }) => (
    <section>{Object.values(briefing).join(' ')}</section>
  ),
  WorkflowPage: ({ children, title, hideHeader }: { children: ReactNode; title: string; hideHeader?: boolean }) => (
    <main data-chromeless={hideHeader ? 'true' : undefined}>
      {hideHeader ? null : <h1>{title}</h1>}
      {children}
    </main>
  ),
  WorkflowMessage: ({
    title,
    children,
    action,
  }: {
    title: string;
    children: ReactNode;
    action?: ReactNode;
  }) => <section><h2>{title}</h2>{children}{action}</section>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  apiMocks.getInterview.mockReset();
  apiMocks.startInterview.mockReset();
  apiMocks.streamAnswer.mockReset();
  apiMocks.streamResume.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function snapshot(questionOrdinal = 1): InterviewSnapshot {
  return {
    status: 'active',
    turnInProgress: false,
    completionStarted: false,
    canResume: false,
    history: [],
    currentQuestion: {
      id: `question-${questionOrdinal}`,
      ordinal: questionOrdinal,
      maxQuestions: 7,
      prompt: `问题 ${questionOrdinal}`,
      options: [{ id: `option-${questionOrdinal}`, label: `选项 ${questionOrdinal}` }],
      acknowledgment: questionOrdinal > 1 ? '收到' : '',
      sufficiency: questionOrdinal * 20,
    },
    errorSummary: null,
  };
}

function pendingSnapshot(completionStarted = true): InterviewSnapshot {
  return {
    status: 'active',
    turnInProgress: false,
    completionStarted,
    canResume: true,
    history: [],
    currentQuestion: null,
    errorSummary: null,
  };
}

function completedSnapshot(): InterviewSnapshot {
  return {
    status: 'completed',
    turnInProgress: false,
    completionStarted: true,
    canResume: false,
    history: [],
    currentQuestion: null,
    errorSummary: null,
  };
}

function finalStrategy(draftId = 'draft-final'): StrategySnapshot {
  return {
    draftId,
    draftVersion: 1,
    readingBriefing: {
      bookIdentity: '定位',
      arc: '脉络',
      assumedKnowledge: '前提',
      readingAdvice: '建议',
    },
    userFacingSummary: '策略',
    trialCandidatePreviews: [],
    adjustmentCount: 0,
    adjustmentLimit: 5,
    canAdjust: true,
  };
}

async function waitFor(assertion: () => void | Promise<void>) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}

describe('useInterviewController', () => {
  it('owns the optimistic answer, turn sequence, and streamed next question', async () => {
    apiMocks.getInterview.mockResolvedValue(snapshot(1));
    apiMocks.streamAnswer.mockImplementation(async (_id, _input, handlers) => {
      handlers.onEvent({
        userBookId: 'book-1',
        streamId: 'stream-1',
        sequence: 1,
        type: 'question_final',
        ordinal: 2,
        maxQuestions: 7,
        question: snapshot(2).currentQuestion!,
      });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let controller: ReturnType<typeof useInterviewController> | null = null;
    const value = () => controller!;

    function Harness() {
      controller = useInterviewController({ userBookId: 'book-1', shouldStart: false });
      return null;
    }

    const root = createRoot(document.createElement('div'));
    roots.push(root);
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    });
    await waitFor(() => expect(value().question?.id).toBe('question-1'));

    act(() => {
      expect(value().submit({ optionId: 'option-1' })).toBe(true);
    });

    await waitFor(() => expect(value().question?.id).toBe('question-2'));
    expect(value().turnSeq).toBe(1);
    expect(value().history).toContainEqual({
      questionId: 'question-1',
      question: '问题 1',
      answer: '选项 1',
    });
  });

  it('lets a durable draft_started event replace the stale answered question snapshot', async () => {
    apiMocks.getInterview.mockResolvedValue(snapshot(1));
    let answerHandlers: { onEvent(event: unknown): void } | null = null;
    apiMocks.streamAnswer.mockImplementation((_id, _input, handlers) => {
      answerHandlers = handlers;
      return new Promise<void>(() => {});
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let controller: ReturnType<typeof useInterviewController> | null = null;
    const value = () => controller!;

    function Harness() {
      controller = useInterviewController({ userBookId: 'book-1', shouldStart: false });
      return null;
    }

    const root = createRoot(document.createElement('div'));
    roots.push(root);
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    });
    await waitFor(() => expect(value().question?.id).toBe('question-1'));

    act(() => {
      expect(value().submit({ optionId: 'option-1' })).toBe(true);
    });
    await waitFor(() => expect(answerHandlers).not.toBeNull());
    act(() => {
      answerHandlers!.onEvent({
        userBookId: 'book-1',
        streamId: 'stream-1',
        sequence: 1,
        speculativeEpoch: 1,
        type: 'draft_started',
        conversationVersion: 2,
      });
    });

    await waitFor(() => expect(value().stream.mode).toBe('draft_streaming'));
    expect(value().snapshot?.status).toBe('active');
    expect(value().draftView).toBe(true);
    expect(value().stream.mode).toBe('draft_streaming');
  });

  it('does not advance the canonical workflow when draft_final is followed by done(interviewing)', async () => {
    apiMocks.getInterview.mockResolvedValue(snapshot(1));
    apiMocks.streamAnswer.mockImplementation(async (_id, _input, handlers) => {
      handlers.onEvent({
        userBookId: 'book-1',
        streamId: 'stream-1',
        sequence: 1,
        type: 'draft_final',
        strategy: finalStrategy(),
      });
      handlers.onEvent({
        userBookId: 'book-1',
        streamId: 'stream-1',
        sequence: 2,
        type: 'done',
        workflowStatus: 'interviewing',
      });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(userBookQueryKeys.detail('book-1'), {
      id: 'book-1',
      workflowStatus: 'interviewing',
      updatedAt: '2026-07-16T00:00:00.000Z',
      sharedBook: {
        id: 'shared-1',
        status: 'ready',
        title: 'Book',
        authors: [],
        coverPath: null,
        errorSummary: null,
      },
      readingProgress: null,
      currentStrategyDraftVersionId: null,
      currentStrategyVersionId: null,
      currentTrialRevisionId: null,
    } satisfies UserBookDetail);
    let controller: ReturnType<typeof useInterviewController> | null = null;
    const value = () => controller!;

    function Harness() {
      controller = useInterviewController({ userBookId: 'book-1', shouldStart: false });
      return null;
    }

    const root = createRoot(document.createElement('div'));
    roots.push(root);
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    });
    await waitFor(() => expect(value().question?.id).toBe('question-1'));

    act(() => {
      expect(value().submit({ optionId: 'option-1' })).toBe(true);
    });

    await waitFor(() => expect(apiMocks.streamAnswer).toHaveBeenCalledOnce());
    expect(queryClient.getQueryData(userBookQueryKeys.strategy('book-1', 'draft-final')))
      .toMatchObject({ draftId: 'draft-final' });
    expect(queryClient.getQueryData<UserBookDetail>(userBookQueryKeys.detail('book-1')))
      .toMatchObject({ workflowStatus: 'interviewing', currentStrategyDraftVersionId: null });
  });

  it('drops late events and errors from an older resume stream after a new answer starts', async () => {
    apiMocks.getInterview
      .mockResolvedValueOnce(pendingSnapshot())
      .mockResolvedValue(snapshot(2));
    let oldHandlers: { onEvent(event: unknown): void } | null = null;
    let rejectOld: ((error: Error) => void) | null = null;
    apiMocks.streamResume.mockImplementation((_id, handlers) => {
      oldHandlers = handlers;
      return new Promise<void>((_resolve, reject) => { rejectOld = reject; });
    });
    apiMocks.streamAnswer.mockImplementation(async (_id, _input, handlers) => {
      handlers.onEvent({
        userBookId: 'book-1',
        streamId: 'new-stream',
        sequence: 1,
        type: 'question_final',
        ordinal: 2,
        maxQuestions: 7,
        question: snapshot(2).currentQuestion!,
      });
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(userBookQueryKeys.detail('book-1'), {
      id: 'book-1',
      workflowStatus: 'interviewing',
      updatedAt: '2026-07-16T00:00:00.000Z',
      sharedBook: {
        id: 'shared-1',
        status: 'ready',
        title: 'Book',
        authors: [],
        coverPath: null,
        errorSummary: null,
      },
      readingProgress: null,
      currentStrategyDraftVersionId: null,
      currentStrategyVersionId: null,
      currentTrialRevisionId: null,
    } satisfies UserBookDetail);
    let controller: ReturnType<typeof useInterviewController> | null = null;
    const value = () => controller!;

    function Harness() {
      controller = useInterviewController({ userBookId: 'book-1', shouldStart: false });
      return null;
    }

    const root = createRoot(document.createElement('div'));
    roots.push(root);
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    });
    await waitFor(() => expect(apiMocks.streamResume).toHaveBeenCalledTimes(1));
    await act(async () => {
      queryClient.setQueryData(userBookQueryKeys.interview('book-1'), snapshot(1));
    });
    await waitFor(() => expect(value().snapshot?.currentQuestion?.id).toBe('question-1'));
    await waitFor(() => expect(value().interactive).toBe(true));

    act(() => {
      expect(value().submit({ optionId: 'option-1' })).toBe(true);
    });
    await waitFor(() => expect(value().question?.id).toBe('question-2'));

    act(() => {
      oldHandlers!.onEvent({
        userBookId: 'book-1',
        streamId: 'old-stream',
        sequence: 99,
        type: 'draft_final',
        strategy: {
          draftId: 'late-draft',
          draftVersion: 1,
          readingBriefing: {
            bookIdentity: 'late',
            arc: 'late',
            assumedKnowledge: 'late',
            readingAdvice: 'late',
          },
          userFacingSummary: 'late',
          trialCandidatePreviews: [],
          adjustmentCount: 0,
          adjustmentLimit: 5,
          canAdjust: true,
        },
      });
      rejectOld!(new ApiError('late error', 0));
    });

    await waitFor(() => expect(value().question?.id).toBe('question-2'));
    expect(value().streamError).toBeNull();
    expect(queryClient.getQueryData<UserBookDetail>(userBookQueryKeys.detail('book-1')))
      .toMatchObject({ workflowStatus: 'interviewing', currentStrategyDraftVersionId: null });
  });
});

describe('InterviewPage recovery', () => {
  it.each([
    ['the next-question turn still owns a lease', {
      ...pendingSnapshot(false),
      turnInProgress: true,
      canResume: false,
    }],
    ['the next-question turn needs to be resumed', pendingSnapshot(false)],
  ] as const)('keeps the interview UI while %s', async (_label, interviewSnapshot) => {
    apiMocks.getInterview.mockResolvedValue(interviewSnapshot);
    apiMocks.streamResume.mockImplementation(() => new Promise<void>(() => {}));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const userBook: UserBookDetail = {
      id: 'book-1',
      workflowStatus: 'interviewing',
      updatedAt: '2026-07-16T00:00:00.000Z',
      sharedBook: {
        id: 'shared-1',
        status: 'ready',
        title: 'Book',
        authors: [],
        coverPath: null,
        errorSummary: null,
      },
      readingProgress: null,
      currentStrategyDraftVersionId: null,
      currentStrategyVersionId: null,
      currentTrialRevisionId: null,
    };
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/user-books/book-1/interview']}>
            <Routes>
              <Route path="/user-books/:id" element={<Outlet context={{ userBook }} />}>
                <Route path="interview" element={<InterviewPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => expect(host.textContent).toContain('认识你 · A Conversation'));
    expect(host.textContent).not.toContain('读之前，先看地图');
    expect(host.textContent).not.toContain('正在完成策略…');
  });

  it('does not render a completed interview as a recovering generation', async () => {
    apiMocks.getInterview.mockResolvedValue(completedSnapshot());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const userBook: UserBookDetail = {
      id: 'book-1',
      workflowStatus: 'interviewing',
      updatedAt: '2026-07-16T00:00:00.000Z',
      sharedBook: {
        id: 'shared-1',
        status: 'ready',
        title: 'Book',
        authors: [],
        coverPath: null,
        errorSummary: null,
      },
      readingProgress: null,
      currentStrategyDraftVersionId: null,
      currentStrategyVersionId: null,
      currentTrialRevisionId: null,
    };
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/user-books/book-1/interview']}>
            <Routes>
              <Route path="/user-books/:id" element={<Outlet context={{ userBook }} />}>
                <Route path="interview" element={<InterviewPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    await waitFor(() => expect(host.textContent).toContain('正在打开策略确认'));
    expect(host.textContent).not.toContain('连接正在恢复');
    expect(apiMocks.streamResume).not.toHaveBeenCalled();
  });

  it('leaves recovering and restores the answer form after a successful current-question snapshot', async () => {
    apiMocks.getInterview.mockResolvedValue(pendingSnapshot());
    apiMocks.streamResume.mockImplementation(() => new Promise<void>(() => {}));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const userBook: UserBookDetail = {
      id: 'book-1',
      workflowStatus: 'interviewing',
      updatedAt: '2026-07-16T00:00:00.000Z',
      sharedBook: {
        id: 'shared-1',
        status: 'ready',
        title: 'Book',
        authors: [],
        coverPath: null,
        errorSummary: null,
      },
      readingProgress: null,
      currentStrategyDraftVersionId: null,
      currentStrategyVersionId: null,
      currentTrialRevisionId: null,
    };
    const host = document.createElement('div');
    const root = createRoot(host);
    roots.push(root);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/user-books/book-1/interview']}>
            <Routes>
              <Route path="/user-books/:id" element={<Outlet context={{ userBook }} />}>
                <Route path="interview" element={<InterviewPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => expect(apiMocks.streamResume).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(host.textContent).toContain('连接正在恢复'));
    expect(host.textContent).toContain('读之前，先看地图');
    expect(host.textContent).toContain('正在完成策略…');
    expect((host.querySelector('textarea[aria-label="策略反馈"]') as HTMLTextAreaElement).disabled).toBe(true);
    expect(host.querySelector('main')?.hasAttribute('data-chromeless')).toBe(false);

    await act(async () => {
      queryClient.setQueryData(userBookQueryKeys.interview('book-1'), snapshot(2));
    });

    await waitFor(() => expect(host.textContent).toContain('信息充足度 40%'));
    await waitFor(() => expect(host.textContent).toContain('问题 2'));
    expect(host.querySelector('textarea[aria-label="自己补充"]')).not.toBeNull();
    expect(host.textContent).not.toContain('连接正在恢复');
  });
});
