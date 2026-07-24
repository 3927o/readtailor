// @vitest-environment happy-dom
/** Verifies complete navigation and ordinary terminal-Run Session reconciliation. */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  AgentRunEvent,
  ReadingSetupSessionSnapshot,
} from '@readtailor/contracts';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserBookDetail } from '../../user-books/api/http';
import type { ReadingSetupApi } from '../api/readingSetupApi';
import { useReadingSetupSession } from './useReadingSetupSession';

const apiMocks = vi.hoisted(() => ({
  getUserBook: vi.fn(),
}));

vi.mock('../../user-books/api/http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../user-books/api/http')>();
  return { ...actual, getUserBook: apiMocks.getUserBook };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const userBookId = '10000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000002';
const runId = '30000000-0000-4000-8000-000000000003';
let root: ReturnType<typeof createRoot> | null = null;
let pathname = '';

function LocationProbe() {
  pathname = useLocation().pathname;
  return null;
}

function Harness({ api }: { api: ReadingSetupApi }) {
  useReadingSetupSession(userBookId, api);
  return <LocationProbe />;
}

function book(): UserBookDetail {
  return {
    id: userBookId,
    workflowStatus: 'on_shelf',
    updatedAt: '2026-07-24T00:00:00.000Z',
    sharedBook: {
      id: '40000000-0000-4000-8000-000000000004',
      status: 'ready',
      title: '测试书',
      authors: ['作者'],
      coverPath: null,
      errorSummary: null,
    },
    readingProgress: null,
    currentStrategyDraftVersionId: null,
    currentStrategyVersionId: null,
    currentTrialRevisionId: null,
  };
}

function session(): ReadingSetupSessionSnapshot {
  return {
    id: sessionId,
    userBookId,
    agentType: 'reading_setup',
    agentState: {
      systemPrompt: 'test',
      modelConfigId: 'test',
      thinkingLevel: 'off',
      messages: [],
      actions: [],
    },
    activeRun: {
      runId,
      status: 'queued',
      snapshot: null,
    },
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
  };
}

async function mountHarness(api: ReadingSetupApi, queryClient: QueryClient) {
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[
          `/user-books/${userBookId}/reading-setup`,
        ]}>
          <Routes>
            <Route
              path="/user-books/:id/reading-setup"
              element={<Harness api={api} />}
            />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  pathname = '';
  apiMocks.getUserBook.mockReset();
});

describe('useReadingSetupSession', () => {
  it('refreshes user-book state and navigates on complete Tool success alone', async () => {
    let completed = false;
    apiMocks.getUserBook.mockImplementation(async () => ({
      ...book(),
      workflowStatus: completed ? 'active_reading' : 'on_shelf',
    }));
    const getSession = vi.fn();
    const subscribeRun = vi.fn(async (
      options: Parameters<ReadingSetupApi['subscribeRun']>[0],
    ) => {
      completed = true;
      const events: AgentRunEvent[] = [
        {
          type: 'run_snapshot',
          runId,
          snapshot: {
            runId,
            lastSequence: 0,
            status: 'running',
            assistantText: '',
            assistantMessage: null,
            tools: [],
            error: null,
          },
        },
        {
          type: 'tool_call_started',
          runId,
          sequence: 1,
          toolCallId: 'complete-1',
          toolName: 'complete_reading_setup',
        },
        {
          type: 'tool_execution_started',
          runId,
          sequence: 2,
          toolCallId: 'complete-1',
          toolName: 'complete_reading_setup',
        },
        {
          type: 'tool_execution_finished',
          runId,
          sequence: 3,
          toolCallId: 'complete-1',
          result: {
            content: [{ type: 'text', text: '完成' }],
            details: {
              toolCallId: 'complete-1',
              trialToolCallId: 'trial-1',
              userBookId,
              workflowStatus: 'active_reading',
              strategyVersionId: '50000000-0000-4000-8000-000000000005',
            },
          },
          isError: false,
        },
      ];
      events.forEach(options.onEvent);
    });
    const getOrCreateSession = vi.fn().mockResolvedValue(session());
    const api: ReadingSetupApi = {
      getOrCreateSession,
      getSession,
      submitAction: vi.fn(),
      subscribeRun,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await mountHarness(api, queryClient);

    expect(apiMocks.getUserBook).toHaveBeenCalled();
    expect(getOrCreateSession).toHaveBeenCalled();
    expect(subscribeRun).toHaveBeenCalled();
    expect(pathname).toBe(`/user-books/${userBookId}/read`);
    expect(getSession).not.toHaveBeenCalled();
    expect(queryClient.getQueryData<UserBookDetail>(['user-book', userBookId]))
      .toMatchObject({ workflowStatus: 'active_reading' });
  });

  it('refreshes committed Session state after an ordinary run_finished', async () => {
    apiMocks.getUserBook.mockResolvedValue(book());
    const refreshed = {
      ...session(),
      activeRun: null,
      updatedAt: '2026-07-24T00:01:00.000Z',
    };
    const getSession = vi.fn().mockResolvedValue(refreshed);
    const subscribeRun = vi.fn(async (
      options: Parameters<ReadingSetupApi['subscribeRun']>[0],
    ) => {
      options.onEvent({
        type: 'run_snapshot',
        runId,
        snapshot: {
          runId,
          lastSequence: 0,
          status: 'running',
          assistantText: '这一轮完成了。',
          assistantMessage: null,
          tools: [],
          error: null,
        },
      });
      options.onEvent({
        type: 'run_finished',
        runId,
        sequence: 1,
        status: 'completed',
      });
    });
    const api: ReadingSetupApi = {
      getOrCreateSession: vi.fn().mockResolvedValue(session()),
      getSession,
      submitAction: vi.fn(),
      subscribeRun,
    };
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await mountHarness(api, queryClient);

    expect(getSession).toHaveBeenCalledWith(sessionId);
    expect(pathname).toBe(`/user-books/${userBookId}/reading-setup`);
    expect(queryClient.getQueryData<ReadingSetupSessionSnapshot>(
      ['reading-setup-session', 'book', userBookId],
    )).toMatchObject({ activeRun: null, updatedAt: refreshed.updatedAt });
  });
});
