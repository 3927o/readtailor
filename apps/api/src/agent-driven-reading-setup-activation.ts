/** Validates a confirmed trial's artifact graph and atomically activates formal reading data. */

import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AGENT_SESSION_STATE_MAX_BYTES,
  type AgentJsonValue,
  type AgentSessionState,
  type BookReaderProfile,
  type Briefing,
  type ConfirmReadingSetupResponse,
  type GenerateTrialSliceArguments,
  type PublishStrategyArguments,
  type ProposedStrategy,
  type Strategy,
} from '@readtailor/contracts';
import {
  indexAgentTranscript,
  type AgentTranscriptIndex,
  type SuccessfulAgentToolCall,
} from '@readtailor/agent-state';
import {
  readingSetupSessions,
  bookReaderProfileVersions,
  interviewSessions,
  sharedBooks,
  strategyDraftVersions,
  strategyVersions,
  userBooks,
  type Database,
} from '@readtailor/database';
import type { BookService } from './books';
import { AgentDrivenReadingSetupError } from './agent-driven-reading-setup-error';

function requireSuccessfulTool(
  transcript: AgentTranscriptIndex,
  toolCallId: string,
  toolName: string,
): SuccessfulAgentToolCall {
  const record = transcript.getSuccessful(toolCallId, toolName);
  if (!record) {
    throw new AgentDrivenReadingSetupError(
      `${toolCallId} 不是当前 session 中成功的 ${toolName} 调用`,
      409,
    );
  }
  return record;
}

function objectValue(value: AgentJsonValue, label: string): Record<string, AgentJsonValue> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new AgentDrivenReadingSetupError(`${label} 不是有效 object`, 409);
  }
  return value;
}

function assertStateSize(state: AgentSessionState): void {
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > AGENT_SESSION_STATE_MAX_BYTES) {
    throw new AgentDrivenReadingSetupError('Agent session state 已达到大小上限', 409);
  }
}

export function createReadingSetupActivationService(options: {
  db: Database;
  books: BookService;
  requireOwnedSession(userId: string, sessionId: string): Promise<{
    userBookId: string;
    agentState: AgentSessionState;
  }>;
}) {
  return {
    async confirm(
      userId: string,
      sessionId: string,
      trialToolCallId: string,
    ): Promise<ConfirmReadingSetupResponse> {
      const initialSession = await options.requireOwnedSession(userId, sessionId);
      const initialReplay = initialSession.agentState.actions.find(
        (action) =>
          action.type === 'trial_confirmation' &&
          action.trialToolCallId === trialToolCallId,
      );
      if (initialReplay?.type === 'trial_confirmation') return initialReplay.result;
      const [initialBook] = await options.db
        .select({ sharedBookId: userBooks.sharedBookId })
        .from(userBooks)
        .where(eq(userBooks.id, initialSession.userBookId))
        .limit(1);
      if (!initialBook) throw new AgentDrivenReadingSetupError('用户书籍不存在', 404);
      const manifest = await options.books.getManifest(initialBook.sharedBookId);
      const placeholderNode = manifest?.nodes
        .filter((node) => node.tailoringEligible)
        .sort((left, right) => left.order - right.order)[0];
      if (!placeholderNode) throw new AgentDrivenReadingSetupError('书籍没有可裁读节点', 409);

      return options.db.transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(readingSetupSessions)
          .where(eq(readingSetupSessions.id, sessionId))
          .for('update')
          .limit(1);
        const [book] = session
          ? await tx
              .select()
              .from(userBooks)
              .where(
                and(
                  eq(userBooks.id, session.userBookId),
                  eq(userBooks.userId, userId),
                  isNull(userBooks.deletedAt),
                ),
              )
              .for('update')
              .limit(1)
          : [];
        if (!session || !book) throw new AgentDrivenReadingSetupError('阅读准备会话不存在', 404);

        const replay = session.agentState.actions.find(
          (action) =>
            action.type === 'trial_confirmation' &&
            action.trialToolCallId === trialToolCallId,
        );
        if (replay?.type === 'trial_confirmation') return replay.result;
        if (session.activeRunId) throw new AgentDrivenReadingSetupError('Agent run 仍在进行中', 409);
        if (book.workflowStatus !== 'on_shelf') {
          throw new AgentDrivenReadingSetupError('用户书籍状态已经变化', 409);
        }
        const [readySharedBook] = await tx
          .select({ id: sharedBooks.id })
          .from(sharedBooks)
          .where(and(eq(sharedBooks.id, book.sharedBookId), eq(sharedBooks.status, 'ready')))
          .limit(1);
        if (!readySharedBook) throw new AgentDrivenReadingSetupError('共享书籍尚未就绪', 409);

        const records = indexAgentTranscript(session.agentState.messages);
        const trialRecord = requireSuccessfulTool(
          records,
          trialToolCallId,
          'generate_trial_slice',
        );
        const trialArgs = objectValue(
          trialRecord.arguments,
          'trial arguments',
        ) as unknown as GenerateTrialSliceArguments;
        const strategyRecord = requireSuccessfulTool(
          records,
          trialArgs.strategyToolCallId,
          'publish_strategy',
        );
        if (
          !session.agentState.actions.some(
            (action) =>
              action.type === 'strategy_confirmation' &&
              action.strategyToolCallId === strategyRecord.toolCallId,
          )
        ) {
          throw new AgentDrivenReadingSetupError('试读使用的 strategy 尚未由用户确认', 409);
        }
        const strategyArgs = objectValue(
          strategyRecord.arguments,
          'strategy arguments',
        ) as unknown as PublishStrategyArguments;
        const briefRecord = requireSuccessfulTool(
          records,
          strategyArgs.briefToolCallId,
          'publish_brief',
        );
        const profileRecord = requireSuccessfulTool(
          records,
          strategyArgs.bookReaderProfileToolCallId,
          'publish_book_reader_profile',
        );
        const trialResult = objectValue(trialRecord.result!, 'trial result');
        if (trialResult.strategyToolCallId !== strategyRecord.toolCallId) {
          throw new AgentDrivenReadingSetupError('试读结果引用的 strategy 不一致', 409);
        }
        const brief = objectValue(briefRecord.arguments, 'brief arguments')
          .brief as unknown as Briefing;
        const profile = objectValue(profileRecord.arguments, 'profile arguments')
          .profile as unknown as BookReaderProfile;
        const strategyCore = strategyArgs.strategy as ProposedStrategy;
        const summary = strategyArgs.summary;
        if (typeof summary !== 'string' || !summary.trim()) {
          throw new AgentDrivenReadingSetupError('strategy summary 无效', 409);
        }
        const placeholder = {
          sectionId: placeholderNode.sectionId,
          segment: placeholderNode.segment,
          reason: 'Agent-driven reading setup compatibility placeholder',
        };
        const strategy: Strategy = {
          ...strategyCore,
          trialCandidates: [
            { ...placeholder },
            { ...placeholder },
            { ...placeholder },
          ],
        };

        const now = new Date();
        let [interview] = await tx
          .select()
          .from(interviewSessions)
          .where(eq(interviewSessions.userBookId, book.id))
          .for('update')
          .limit(1);
        if (interview) {
          [interview] = await tx
            .update(interviewSessions)
            .set({
              status: 'completed',
              turnLeaseId: null,
              turnLeaseVersion: null,
              turnLeaseClaimedAt: null,
              turnLeaseExpiresAt: null,
              completedAt: now,
              updatedAt: now,
            })
            .where(eq(interviewSessions.id, interview.id))
            .returning();
        } else {
          [interview] = await tx
            .insert(interviewSessions)
            .values({
              userBookId: book.id,
              status: 'completed',
              completedAt: now,
            })
            .returning();
        }
        if (!interview) throw new AgentDrivenReadingSetupError('访谈结构外壳创建失败', 503);

        const [profileVersionRow, draftVersionRow, strategyVersionRow] = await Promise.all([
          tx
            .select({ next: sql<number>`coalesce(max(${bookReaderProfileVersions.version}), 0)::int + 1` })
            .from(bookReaderProfileVersions)
            .where(eq(bookReaderProfileVersions.userBookId, book.id))
            .then((rows) => rows[0]),
          tx
            .select({ next: sql<number>`coalesce(max(${strategyDraftVersions.version}), 0)::int + 1` })
            .from(strategyDraftVersions)
            .where(eq(strategyDraftVersions.userBookId, book.id))
            .then((rows) => rows[0]),
          tx
            .select({ next: sql<number>`coalesce(max(${strategyVersions.version}), 0)::int + 1` })
            .from(strategyVersions)
            .where(eq(strategyVersions.userBookId, book.id))
            .then((rows) => rows[0]),
        ]);
        const [savedProfile] = await tx
          .insert(bookReaderProfileVersions)
          .values({
            userBookId: book.id,
            interviewSessionId: interview.id,
            version: profileVersionRow?.next ?? 1,
            profile,
          })
          .returning();
        if (!savedProfile) throw new AgentDrivenReadingSetupError('书籍读者画像创建失败', 503);
        const [draft] = await tx
          .insert(strategyDraftVersions)
          .values({
            userBookId: book.id,
            bookReaderProfileVersionId: savedProfile.id,
            version: draftVersionRow?.next ?? 1,
            status: 'confirmed',
            readingBriefing: brief,
            userFacingSummary: summary,
            strategy,
            confirmedAt: now,
          })
          .returning();
        if (!draft) throw new AgentDrivenReadingSetupError('阅读策略草稿创建失败', 503);
        const [formalStrategy] = await tx
          .insert(strategyVersions)
          .values({
            userBookId: book.id,
            sourceDraftVersionId: draft.id,
            version: strategyVersionRow?.next ?? 1,
            userFacingSummary: summary,
            strategy,
          })
          .returning();
        if (!formalStrategy) throw new AgentDrivenReadingSetupError('正式阅读策略创建失败', 503);

        const result: ConfirmReadingSetupResponse = {
          userBookId: book.id,
          workflowStatus: 'active_reading',
          strategyVersionId: formalStrategy.id,
        };
        const nextState: AgentSessionState = {
          ...session.agentState,
          actions: [
            ...session.agentState.actions,
            {
              type: 'trial_confirmation',
              trialToolCallId,
              submittedAt: now.toISOString(),
              result,
            },
          ],
        };
        assertStateSize(nextState);

        const [activated] = await tx
          .update(userBooks)
          .set({
            workflowStatus: 'active_reading',
            currentInterviewSessionId: interview.id,
            currentBookReaderProfileVersionId: savedProfile.id,
            currentStrategyDraftVersionId: draft.id,
            currentStrategyVersionId: formalStrategy.id,
            currentTrialRevisionId: null,
            updatedAt: now,
          })
          .where(and(eq(userBooks.id, book.id), eq(userBooks.workflowStatus, 'on_shelf')))
          .returning({ id: userBooks.id });
        if (!activated) throw new AgentDrivenReadingSetupError('用户书籍状态已经变化', 409);
        await tx
          .update(readingSetupSessions)
          .set({ agentState: nextState, updatedAt: now })
          .where(and(eq(readingSetupSessions.id, session.id), isNull(readingSetupSessions.activeRunId)));
        return result;
      });
    },
  };
}
