/** Persists reading-setup sessions and enforces the single-active-run write fence. */

import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AGENT_SESSION_STATE_MAX_BYTES,
  type AgentSessionState,
} from '@readtailor/contracts';
import type { Database } from './index';
import { readingSetupSessions, userBooks } from './schema';

export class ReadingSetupSessionStoreError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'state_too_large' | 'not_serializable',
  ) {
    super(message);
    this.name = 'ReadingSetupSessionStoreError';
  }
}

export interface ReadingSetupSessionRecord {
  id: string;
  userBookId: string;
  agentState: AgentSessionState;
  activeRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function assertBoundedState(state: AgentSessionState): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(state);
  } catch {
    throw new ReadingSetupSessionStoreError(
      'Agent session state 必须是可序列化 JSON',
      'not_serializable',
    );
  }
  if (Buffer.byteLength(serialized, 'utf8') > AGENT_SESSION_STATE_MAX_BYTES) {
    throw new ReadingSetupSessionStoreError(
      `Agent session state 超过 ${AGENT_SESSION_STATE_MAX_BYTES} bytes 上限`,
      'state_too_large',
    );
  }
}

export function createReadingSetupSessionStore(options: { db: Database }) {
  const { db } = options;

  const getOwnedByUserBook = async (
    userId: string,
    userBookId: string,
  ): Promise<ReadingSetupSessionRecord | undefined> => {
    const [row] = await db
      .select({ session: readingSetupSessions })
      .from(readingSetupSessions)
      .innerJoin(userBooks, eq(userBooks.id, readingSetupSessions.userBookId))
      .where(and(eq(userBooks.id, userBookId), eq(userBooks.userId, userId)))
      .limit(1);
    return row?.session;
  };

  const getOwnedById = async (
    userId: string,
    sessionId: string,
  ): Promise<ReadingSetupSessionRecord | undefined> => {
    const [row] = await db
      .select({ session: readingSetupSessions })
      .from(readingSetupSessions)
      .innerJoin(userBooks, eq(userBooks.id, readingSetupSessions.userBookId))
      .where(and(eq(readingSetupSessions.id, sessionId), eq(userBooks.userId, userId)))
      .limit(1);
    return row?.session;
  };

  const getById = async (
    sessionId: string,
  ): Promise<ReadingSetupSessionRecord | undefined> => {
    const [row] = await db
      .select()
      .from(readingSetupSessions)
      .where(eq(readingSetupSessions.id, sessionId))
      .limit(1);
    return row;
  };

  return {
    getOwnedByUserBook,
    getOwnedById,
    getById,

    async createForOwnedUserBook(input: {
      userId: string;
      userBookId: string;
      initialState: AgentSessionState;
    }): Promise<ReadingSetupSessionRecord> {
      assertBoundedState(input.initialState);
      const [owned] = await db
        .select({ id: userBooks.id })
        .from(userBooks)
        .where(and(eq(userBooks.id, input.userBookId), eq(userBooks.userId, input.userId)))
        .limit(1);
      if (!owned) {
        throw new ReadingSetupSessionStoreError('用户书籍不存在', 'not_found');
      }

      await db
        .insert(readingSetupSessions)
        .values({
          userBookId: input.userBookId,
          agentState: input.initialState,
        })
        .onConflictDoNothing({ target: readingSetupSessions.userBookId });

      const session = await getOwnedByUserBook(input.userId, input.userBookId);
      if (!session) {
        throw new ReadingSetupSessionStoreError('阅读准备会话不存在', 'not_found');
      }
      return session;
    },

    async claimRun(
      sessionId: string,
      runId: string,
    ): Promise<{ claimed: boolean; activeRunId: string | null }> {
      const [claimed] = await db
        .update(readingSetupSessions)
        .set({ activeRunId: runId, updatedAt: new Date() })
        .where(
          and(
            eq(readingSetupSessions.id, sessionId),
            isNull(readingSetupSessions.activeRunId),
          ),
        )
        .returning({ activeRunId: readingSetupSessions.activeRunId });
      if (claimed) return { claimed: true, activeRunId: claimed.activeRunId };

      const session = await getById(sessionId);
      if (!session) {
        throw new ReadingSetupSessionStoreError('阅读准备会话不存在', 'not_found');
      }
      return { claimed: false, activeRunId: session.activeRunId };
    },

    async claimInitialRun(
      sessionId: string,
      runId: string,
    ): Promise<{ claimed: boolean; activeRunId: string | null }> {
      const [claimed] = await db
        .update(readingSetupSessions)
        .set({ activeRunId: runId, updatedAt: new Date() })
        .where(
          and(
            eq(readingSetupSessions.id, sessionId),
            isNull(readingSetupSessions.activeRunId),
            sql`jsonb_array_length(${readingSetupSessions.agentState} -> 'messages') = 0`,
            sql`jsonb_array_length(${readingSetupSessions.agentState} -> 'actions') = 0`,
          ),
        )
        .returning({ activeRunId: readingSetupSessions.activeRunId });
      if (claimed) return { claimed: true, activeRunId: claimed.activeRunId };

      const session = await getById(sessionId);
      if (!session) {
        throw new ReadingSetupSessionStoreError('阅读准备会话不存在', 'not_found');
      }
      return { claimed: false, activeRunId: session.activeRunId };
    },

    async commitRun(
      sessionId: string,
      runId: string,
      agentState: AgentSessionState,
    ): Promise<boolean> {
      assertBoundedState(agentState);
      const rows = await db
        .update(readingSetupSessions)
        .set({ agentState, activeRunId: null, updatedAt: new Date() })
        .where(
          and(
            eq(readingSetupSessions.id, sessionId),
            eq(readingSetupSessions.activeRunId, runId),
          ),
        )
        .returning({ id: readingSetupSessions.id });
      return rows.length === 1;
    },

    async failRun(sessionId: string, runId: string): Promise<boolean> {
      const rows = await db
        .update(readingSetupSessions)
        .set({ activeRunId: null, updatedAt: new Date() })
        .where(
          and(
            eq(readingSetupSessions.id, sessionId),
            eq(readingSetupSessions.activeRunId, runId),
          ),
        )
        .returning({ id: readingSetupSessions.id });
      return rows.length === 1;
    },
  };
}

export type ReadingSetupSessionStore = ReturnType<typeof createReadingSetupSessionStore>;
