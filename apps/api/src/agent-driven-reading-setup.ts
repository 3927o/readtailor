/** Owns reading-setup session eligibility, commands, and run admission. */

import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type {
  AgentRunInput,
  AgentSessionState,
  PresentQuestionArguments,
  ReadingSetupSessionSnapshot,
  StartAgentRunResponse,
  SubmitAgentQuestionAnswerRequest,
} from '@readtailor/contracts';
import { indexAgentTranscript } from '@readtailor/agent-state';
import {
  createReadingSetupSessionStore,
  sharedBooks,
  userBooks,
  type Database,
} from '@readtailor/database';
import type { AgentRunObserver, AgentRunQueue } from '@readtailor/queue';
import { createAgentRunObservation } from './agent-run-observation';
import { createReadingSetupActivationService } from './agent-driven-reading-setup-activation';
import { AgentDrivenReadingSetupError } from './agent-driven-reading-setup-error';
import type { BookService } from './books';

export { AgentDrivenReadingSetupError } from './agent-driven-reading-setup-error';

function requireQuestionArguments(
  state: AgentSessionState,
  questionToolCallId: string,
): PresentQuestionArguments {
  const question = indexAgentTranscript(state.messages).getSuccessful(
    questionToolCallId,
    'present_question',
  );
  if (!question) {
    throw new AgentDrivenReadingSetupError(
      `${questionToolCallId} 不是当前 session 中成功的 present_question 调用`,
      409,
    );
  }
  const args = question.arguments;
  if (!args || Array.isArray(args) || typeof args !== 'object') {
    throw new AgentDrivenReadingSetupError('question arguments 不是有效 object', 409);
  }
  return args as unknown as PresentQuestionArguments;
}

export function createAgentDrivenReadingSetupService(options: {
  db: Database;
  books: BookService;
  queue: AgentRunQueue;
  observer: AgentRunObserver;
  initialState(): AgentSessionState;
}) {
  const store = createReadingSetupSessionStore({ db: options.db });

  const getEligibleBook = async (userId: string, userBookId: string) => {
    const [row] = await options.db
      .select({ userBook: userBooks, sharedBook: sharedBooks })
      .from(userBooks)
      .innerJoin(sharedBooks, eq(sharedBooks.id, userBooks.sharedBookId))
      .where(
        and(
          eq(userBooks.id, userBookId),
          eq(userBooks.userId, userId),
          isNull(userBooks.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new AgentDrivenReadingSetupError('用户书籍不存在', 404);
    if (row.sharedBook.status !== 'ready' || row.userBook.workflowStatus !== 'on_shelf') {
      throw new AgentDrivenReadingSetupError('该书当前不能进入阅读准备', 409);
    }
    return row;
  };

  const snapshot = async (
    session: Awaited<ReturnType<typeof store.getById>> & {},
  ): Promise<ReadingSetupSessionSnapshot> => {
    let activeRun: ReadingSetupSessionSnapshot['activeRun'] = null;
    if (session.activeRunId) {
      const run = await options.observer.getRun(session.activeRunId);
      activeRun = {
        runId: session.activeRunId,
        status: run?.progress?.snapshot.status ?? 'queued',
        snapshot: run?.progress?.snapshot ?? null,
      };
    }
    return {
      id: session.id,
      userBookId: session.userBookId,
      agentType: 'reading_setup',
      agentState: session.agentState,
      activeRun,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
    };
  };

  const requireOwnedSession = async (userId: string, sessionId: string) => {
    const session = await store.getOwnedById(userId, sessionId);
    if (!session) throw new AgentDrivenReadingSetupError('阅读准备会话不存在', 404);
    return session;
  };

  const enqueueClaimedRun = async (
    sessionId: string,
    runId: string,
    input: AgentRunInput,
  ): Promise<void> => {
    try {
      await options.queue.add(
        'reading_setup',
        { agentType: 'reading_setup', sessionId, runId, input },
        { jobId: runId },
      );
    } catch (error) {
      await store.failRun(sessionId, runId);
      throw new AgentDrivenReadingSetupError(
        `Agent run 暂时无法入队：${error instanceof Error ? error.message : 'unknown error'}`,
        503,
      );
    }
  };

  const startRun = async (
    userId: string,
    sessionId: string,
    input: AgentRunInput,
  ): Promise<StartAgentRunResponse> => {
    const session = await requireOwnedSession(userId, sessionId);
    await getEligibleBook(userId, session.userBookId);
    const runId = randomUUID();
    const claim = await store.claimRun(session.id, runId);
    if (!claim.claimed) {
      if (!claim.activeRunId) throw new AgentDrivenReadingSetupError('Agent run claim 失败', 409);
      return { runId: claim.activeRunId, accepted: false };
    }
    await enqueueClaimedRun(session.id, runId, input);
    return { runId, accepted: true };
  };

  const ensureInitialRun = async (
    userId: string,
    session: Awaited<ReturnType<typeof requireOwnedSession>>,
  ) => {
    if (
      session.agentState.messages.length > 0 ||
      session.agentState.actions.length > 0
    ) {
      return session;
    }

    const runId = randomUUID();
    const claim = await store.claimInitialRun(session.id, runId);
    if (claim.claimed) {
      await enqueueClaimedRun(session.id, runId, { type: 'session_start' });
    }

    const current = await requireOwnedSession(userId, session.id);
    if (
      current.agentState.messages.length === 0 &&
      current.agentState.actions.length === 0 &&
      !current.activeRunId
    ) {
      throw new AgentDrivenReadingSetupError('首次 Agent run 未能启动，请重试', 503);
    }
    return current;
  };

  const runObservation = createAgentRunObservation({
    observer: options.observer,
    authorizeSession: async (userId, sessionId) => {
      await requireOwnedSession(userId, sessionId);
    },
    runNotFound: () => new AgentDrivenReadingSetupError('Agent run 不存在', 404),
  });
  const activation = createReadingSetupActivationService({
    db: options.db,
    books: options.books,
    requireOwnedSession,
  });

  return {
    async getOrCreateSession(
      userId: string,
      userBookId: string,
    ): Promise<ReadingSetupSessionSnapshot> {
      await getEligibleBook(userId, userBookId);
      const existing = await store.getOwnedByUserBook(userId, userBookId);
      const session = existing ?? await store.createForOwnedUserBook({
        userId,
        userBookId,
        initialState: options.initialState(),
      });
      return snapshot(await ensureInitialRun(userId, session));
    },

    async getSession(
      userId: string,
      sessionId: string,
    ): Promise<ReadingSetupSessionSnapshot> {
      const session = await requireOwnedSession(userId, sessionId);
      await getEligibleBook(userId, session.userBookId);
      return snapshot(session);
    },

    submitMessage(userId: string, sessionId: string, message: string) {
      const text = message.trim();
      if (!text) throw new AgentDrivenReadingSetupError('消息不能为空', 400);
      return startRun(userId, sessionId, { type: 'message', text });
    },

    async submitQuestionAnswer(
      userId: string,
      sessionId: string,
      input: SubmitAgentQuestionAnswerRequest,
    ): Promise<StartAgentRunResponse> {
      const session = await requireOwnedSession(userId, sessionId);
      const args = requireQuestionArguments(session.agentState, input.questionToolCallId);
      const optionIds = new Set(args.options.map((option) => option.id));
      if (input.selectedOptionIds.some((id) => !optionIds.has(id))) {
        throw new AgentDrivenReadingSetupError('问题回答包含无效选项', 400);
      }
      if (args.selectionMode === 'single' && input.selectedOptionIds.length > 1) {
        throw new AgentDrivenReadingSetupError('该问题只允许单选', 400);
      }
      if (!args.allowFreeText && input.freeText?.trim()) {
        throw new AgentDrivenReadingSetupError('该问题不允许自由文本', 400);
      }
      if (input.selectedOptionIds.length === 0 && !input.freeText?.trim()) {
        throw new AgentDrivenReadingSetupError('问题回答不能为空', 400);
      }
      return startRun(userId, sessionId, {
        type: 'question_answer',
        questionToolCallId: input.questionToolCallId,
        selectedOptionIds: input.selectedOptionIds,
        freeText: input.freeText?.trim() || null,
      });
    },

    getRunSnapshot: runObservation.getSnapshot,
    subscribeRun: runObservation.subscribe,
    confirm: activation.confirm,
  };
}

export type AgentDrivenReadingSetupService = ReturnType<typeof createAgentDrivenReadingSetupService>;
