/** Owns formal session queries, user actions, Run observation, and transcript composition. */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { reduceAgentRunEvent } from '@readtailor/agent-state';
import type {
  AgentRunDisplaySnapshot,
  AgentRunEvent,
  SubmitReadingSetupActionRequest,
} from '@readtailor/contracts';
import { useNavigate } from 'react-router';
import {
  getUserBook,
  type UserBookDetail,
} from '../../user-books/api/http';
import { userBookQueryKeys } from '../../user-books/queryKeys';
import { routeForUserBook } from '../../user-books/routes';
import {
  readingSetupApi,
  readingSetupQueryKeys,
  type ReadingSetupApi,
} from '../api/readingSetupApi';
import {
  applyOptimisticReadingSetupAction,
  projectReadingSetupTranscript,
  type OptimisticReadingSetupAction,
} from '../transcript/projectTranscript';
import {
  createLiveRunOrder,
  projectLiveReadingSetupTranscript,
  reduceLiveRunOrder,
  type LiveRunOrder,
} from '../transcript/projectLiveTranscript';
import { projectPersistedReadingSetupTranscript } from '../transcript/projectPersistedTranscript';
import { unwrapToolResult } from '../transcript/projectToolEntry';
import type { ReadingSetupTranscriptEntry } from '../transcript/types';
import {
  reduceReadingSetupConnection,
  type ReadingSetupConnection,
} from './runConnection';
import type {
  AnswerQuestionCommand,
  ReadingSetupCommands,
  ReadingSetupController,
  SendFeedbackCommand,
} from './types';

function emptyRun(runId: string): AgentRunDisplaySnapshot {
  return {
    runId,
    lastSequence: 0,
    status: 'queued',
    assistantText: '',
    assistantMessage: null,
    tools: [],
    error: null,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function completedReadingSetup(snapshot: AgentRunDisplaySnapshot): boolean {
  return snapshot.tools.some((tool) => {
    if (
      tool.toolName !== 'complete_reading_setup'
      || tool.executionStatus !== 'completed'
      || tool.isError
    ) return false;
    return record(unwrapToolResult(tool.result))?.workflowStatus === 'active_reading';
  });
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useReadingSetupSession(
  userBookId: string,
  api: ReadingSetupApi = readingSetupApi,
): ReadingSetupController {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [connection, dispatchConnection] = useReducer(
    reduceReadingSetupConnection,
    'connecting' as ReadingSetupConnection,
  );
  const [activeRun, setActiveRunState] = useState<AgentRunDisplaySnapshot | null>(null);
  const activeRunRef = useRef<AgentRunDisplaySnapshot | null>(null);
  const [liveRunOrder, setLiveRunOrderState] = useState<LiveRunOrder | null>(null);
  const liveRunOrderRef = useRef<LiveRunOrder | null>(null);
  const [optimisticAction, setOptimisticAction] =
    useState<OptimisticReadingSetupAction | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const actionSequence = useRef(0);
  const completionHandledRuns = useRef(new Set<string>());
  const refreshedRuns = useRef(new Set<string>());
  const optimisticBaseUpdatedAt = useRef<string | null>(null);

  // Load the host book first so an already-activated book never reopens setup.
  const bookQuery = useQuery({
    queryKey: userBookQueryKeys.detail(userBookId),
    queryFn: () => getUserBook(userBookId),
    enabled: Boolean(userBookId),
    staleTime: 0,
  });
  const sessionQuery = useQuery({
    queryKey: readingSetupQueryKeys.byBook(userBookId),
    queryFn: () => api.getOrCreateSession(userBookId),
    enabled: Boolean(userBookId) && bookQuery.data?.workflowStatus === 'on_shelf',
    staleTime: 0,
  });
  const sessionRef = useRef(sessionQuery.data);
  sessionRef.current = sessionQuery.data;

  const setActiveRun = useCallback((snapshot: AgentRunDisplaySnapshot | null) => {
    activeRunRef.current = snapshot;
    setActiveRunState(snapshot);
  }, []);

  const replaceActiveRun = useCallback((snapshot: AgentRunDisplaySnapshot | null) => {
    setActiveRun(snapshot);
    const order = createLiveRunOrder(snapshot);
    liveRunOrderRef.current = order;
    setLiveRunOrderState(order);
  }, [setActiveRun]);

  // Keep the URL aligned with the user-book workflow owned by the backend.
  useEffect(() => {
    const book = bookQuery.data;
    if (!book || book.workflowStatus === 'on_shelf') return;
    navigate(routeForUserBook(book), { replace: true });
  }, [bookQuery.data, navigate]);

  useEffect(() => {
    const session = sessionQuery.data;
    if (!session) return;
    const observed = session.activeRun?.snapshot
      ?? (session.activeRun ? emptyRun(session.activeRun.runId) : null);
    if (!observed) {
      replaceActiveRun(null);
      return;
    }
    const current = activeRunRef.current;
    if (
      current?.runId === observed.runId
      && current.lastSequence > observed.lastSequence
    ) return;
    replaceActiveRun(observed);
  }, [
    sessionQuery.data?.activeRun?.runId,
    sessionQuery.data?.activeRun?.snapshot,
    sessionQuery.data?.updatedAt,
    replaceActiveRun,
  ]);

  useEffect(() => {
    if (
      optimisticAction?.delivery === 'sent'
      && optimisticBaseUpdatedAt.current
      && sessionQuery.data?.updatedAt !== optimisticBaseUpdatedAt.current
    ) {
      setOptimisticAction(null);
      optimisticBaseUpdatedAt.current = null;
    }
  }, [optimisticAction?.delivery, sessionQuery.data?.updatedAt]);

  useEffect(() => {
    if (bookQuery.isError || sessionQuery.isError) {
      dispatchConnection({ type: 'closed' });
      return;
    }
    if (bookQuery.isPending || sessionQuery.isPending) {
      dispatchConnection({ type: 'connecting' });
      return;
    }
    if (!activeRun || !['queued', 'running'].includes(activeRun.status)) {
      dispatchConnection({ type: 'connected' });
    }
  }, [
    activeRun,
    bookQuery.isError,
    bookQuery.isPending,
    sessionQuery.isError,
    sessionQuery.isPending,
  ]);

  // A successful complete Tool is the business completion signal; run_finished is not.
  const enterReader = useCallback((runId: string) => {
    if (completionHandledRuns.current.has(runId)) return;
    completionHandledRuns.current.add(runId);
    queryClient.setQueryData(
      userBookQueryKeys.detail(userBookId),
      (current: UserBookDetail | undefined) =>
        current ? { ...current, workflowStatus: 'active_reading' as const } : current,
    );
    void queryClient.invalidateQueries({ queryKey: userBookQueryKeys.all });
    void queryClient.invalidateQueries({ queryKey: ['user-books'] });
    navigate(`/user-books/${encodeURIComponent(userBookId)}/read`, { replace: true });
  }, [navigate, queryClient, userBookId]);

  // Ordinary terminal Runs reconcile their transient projection through GET session.
  const refreshSessionAfterRun = useCallback(async (
    runId: string,
    status: 'completed' | 'failed',
    error?: string,
  ) => {
    if (
      refreshedRuns.current.has(runId)
      || completionHandledRuns.current.has(runId)
    ) return;
    refreshedRuns.current.add(runId);
    if (status === 'failed') setRunError(error ?? '这一轮没有完成，可以从刚才的位置再试一次。');
    const session = sessionRef.current;
    if (!session) return;
    try {
      const refreshed = await api.getSession(session.id);
      queryClient.setQueryData(
        readingSetupQueryKeys.byBook(userBookId),
        refreshed,
      );
      setOptimisticAction(null);
      optimisticBaseUpdatedAt.current = null;
      const observed = refreshed.activeRun?.snapshot
        ?? (refreshed.activeRun ? emptyRun(refreshed.activeRun.runId) : null);
      replaceActiveRun(observed);
      dispatchConnection({ type: 'connected' });
    } catch (refreshError) {
      setRunError(errorMessage(refreshError, '会话暂时没有恢复成功。'));
      dispatchConnection({ type: 'closed' });
    }
  }, [api, queryClient, replaceActiveRun, userBookId]);

  // Observe the active Run independently from the Worker and reconnect on transport EOF.
  useEffect(() => {
    const session = sessionQuery.data;
    if (!session || !activeRun || !['queued', 'running'].includes(activeRun.status)) {
      return;
    }
    const controller = new AbortController();
    let stopped = false;
    dispatchConnection({ type: 'connecting' });

    const onEvent = (event: AgentRunEvent) => {
      if (stopped) return;
      const next = reduceAgentRunEvent(activeRunRef.current, event);
      setActiveRun(next);
      const nextOrder = reduceLiveRunOrder(liveRunOrderRef.current, event);
      liveRunOrderRef.current = nextOrder;
      setLiveRunOrderState(nextOrder);
      dispatchConnection({ type: 'connected' });

      if (completedReadingSetup(next)) {
        enterReader(next.runId);
        return;
      }
      if (event.type === 'run_finished') {
        void refreshSessionAfterRun(
          event.runId,
          event.status,
          event.status === 'failed' ? event.error : undefined,
        );
        return;
      }
      if (
        event.type === 'run_snapshot'
        && (event.snapshot.status === 'completed' || event.snapshot.status === 'failed')
      ) {
        void refreshSessionAfterRun(
          event.runId,
          event.snapshot.status,
          event.snapshot.error ?? undefined,
        );
      }
    };

    const observe = async () => {
      while (!stopped) {
        try {
          await api.subscribeRun({
            sessionId: session.id,
            runId: activeRun.runId,
            signal: controller.signal,
            onEvent,
          });
          return;
        } catch {
          if (controller.signal.aborted) return;
          dispatchConnection({ type: 'interrupted', retrying: true });
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
      }
    };
    void observe();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [
    activeRun?.runId,
    activeRun?.status,
    api,
    enterReader,
    refreshSessionAfterRun,
    retryVersion,
    sessionQuery.data?.id,
    setActiveRun,
  ]);

  // Every visible user action shares the same backend admission and optimistic boundary.
  const submitAction = useCallback(async (
    action: SubmitReadingSetupActionRequest,
  ) => {
    const session = sessionRef.current;
    if (!session) throw new Error('阅读准备会话还没有恢复');
    actionSequence.current += 1;
    const optimisticId = `optimistic-action-${actionSequence.current}`;
    optimisticBaseUpdatedAt.current = session.updatedAt;
    setRunError(null);
    setOptimisticAction({ id: optimisticId, action, delivery: 'sending' });
    try {
      const started = await api.submitAction(session.id, action);
      if (!started.accepted) {
        optimisticBaseUpdatedAt.current = null;
        setOptimisticAction({ id: optimisticId, action, delivery: 'failed' });
        replaceActiveRun(emptyRun(started.runId));
        throw new Error('AI 正在处理另一条输入，请等这一轮结束后再试。');
      }
      setOptimisticAction({ id: optimisticId, action, delivery: 'sent' });
      replaceActiveRun(emptyRun(started.runId));
      dispatchConnection({ type: 'connecting' });
    } catch (error) {
      setOptimisticAction((current) =>
        current?.id === optimisticId ? { ...current, delivery: 'failed' } : current);
      optimisticBaseUpdatedAt.current = null;
      throw error;
    }
  }, [api, replaceActiveRun]);

  const commands = useMemo<ReadingSetupCommands>(() => ({
    answerQuestion(input: AnswerQuestionCommand) {
      return submitAction({
        type: 'question_answer',
        questionToolCallId: input.toolCallId,
        selectedOptionIds: input.selectedOptionIds.slice(0, 1),
        freeText: input.freeText,
      });
    },
    sendFeedback(input: SendFeedbackCommand) {
      return submitAction({
        type: 'feedback',
        targetToolCallId: input.targetToolCallId,
        message: input.message,
      });
    },
    confirmStrategy(toolCallId: string) {
      return submitAction({ type: 'confirmation', targetToolCallId: toolCallId });
    },
    confirmTrial(toolCallId: string) {
      return submitAction({ type: 'confirmation', targetToolCallId: toolCallId });
    },
    async retryConnection() {
      dispatchConnection({ type: 'connecting' });
      setRunError(null);
      setRetryVersion((current) => current + 1);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(userBookId) }),
        queryClient.invalidateQueries({ queryKey: readingSetupQueryKeys.byBook(userBookId) }),
      ]);
    },
  }), [queryClient, submitAction, userBookId]);

  // Presentation receives only ordered view models, never transport DTOs.
  const entries = useMemo(() => {
    const persisted = sessionQuery.data
      ? projectPersistedReadingSetupTranscript(sessionQuery.data.agentState)
      : [];
    const withOptimistic = applyOptimisticReadingSetupAction(
      persisted,
      optimisticAction,
    );
    const projected = projectReadingSetupTranscript({
      persisted: withOptimistic,
      live: projectLiveReadingSetupTranscript(activeRun, liveRunOrder),
    });
    const notices: ReadingSetupTranscriptEntry[] = [];
    const queryFailure = bookQuery.error ?? sessionQuery.error;
    if (
      !sessionQuery.data
      && !queryFailure
      && (bookQuery.isPending || sessionQuery.isPending)
    ) {
      notices.push({
        id: 'session-loading',
        kind: 'notice',
        tone: 'quiet',
        message: '正在接上我们之前聊到的位置…',
      });
    }
    if (queryFailure) {
      notices.push({
        id: 'session-query-error',
        kind: 'notice',
        tone: 'error',
        message: errorMessage(queryFailure, '阅读准备会话暂时打不开。'),
        action: { kind: 'retry_connection', label: '再试一次' },
      });
    } else if (connection === 'reconnecting') {
      notices.push({
        id: 'session-reconnecting',
        kind: 'notice',
        tone: 'quiet',
        message: '连接刚刚断开了一下，正在重新接上…',
      });
    } else if (connection === 'disconnected') {
      notices.push({
        id: 'session-disconnected',
        kind: 'notice',
        tone: 'warning',
        message: '实时连接暂时没有接上。',
        action: { kind: 'retry_connection', label: '重新连接' },
      });
    }
    if (runError) {
      notices.push({
        id: 'session-run-error',
        kind: 'notice',
        tone: 'error',
        message: runError,
      });
    }
    return [...projected, ...notices];
  }, [
    activeRun,
    bookQuery.error,
    bookQuery.isPending,
    connection,
    liveRunOrder,
    optimisticAction,
    runError,
    sessionQuery.data,
    sessionQuery.error,
    sessionQuery.isPending,
  ]);

  const runBusy = Boolean(
    activeRun && (activeRun.status === 'queued' || activeRun.status === 'running'),
  );
  const requestBusy = optimisticAction?.delivery === 'sending'
    || optimisticAction?.delivery === 'sent';

  return {
    view: {
      book: {
        id: userBookId,
        title: bookQuery.data?.sharedBook.title ?? '这本书',
        authors: bookQuery.data?.sharedBook.authors ?? [],
      },
      entries,
      connection,
      interactionsLocked: Boolean(
        runBusy
        || requestBusy
        || bookQuery.isPending
        || sessionQuery.isPending
        || bookQuery.isError
        || sessionQuery.isError
      ),
    },
    commands,
  };
}
