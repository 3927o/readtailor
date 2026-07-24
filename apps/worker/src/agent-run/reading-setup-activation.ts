/** Validates a confirmed trial graph and performs the existing formal-data activation transaction. */

import { and, eq, sql } from 'drizzle-orm';
import type {
  AgentJsonValue,
  AgentRunInput,
  AgentSessionState,
  BookReaderProfile,
  Briefing,
  CompleteReadingSetupResult,
  GenerateTrialSliceArguments,
  PublishStrategyArguments,
  ProposedStrategy,
  Strategy,
} from '@readtailor/contracts';
import {
  indexAgentTranscript,
  type AgentTranscriptIndex,
  type SuccessfulAgentToolCall,
} from '@readtailor/agent-state';
import {
  bookReaderProfileVersions,
  interviewSessions,
  readingSetupSessions,
  sharedBooks,
  strategyDraftVersions,
  strategyVersions,
  userBooks,
  type Database,
} from '@readtailor/database';
import type { ReadingManifest } from '@readtailor/reader-core';

function requireSuccessfulTool(
  transcript: AgentTranscriptIndex,
  toolCallId: string,
  toolName: string,
): SuccessfulAgentToolCall {
  const record = transcript.getSuccessful(toolCallId, toolName);
  if (!record) {
    throw new Error(`${toolCallId} 不是当前 session 中成功的 ${toolName} 调用`);
  }
  return record;
}

function objectValue(value: AgentJsonValue, label: string): Record<string, AgentJsonValue> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`${label} 不是有效 object`);
  }
  return value;
}

function hasConfirmation(
  state: AgentSessionState,
  input: AgentRunInput,
  targetToolCallId: string,
  targetToolName: 'publish_strategy' | 'generate_trial_slice',
): boolean {
  return (
    (
      input.type === 'confirmation' &&
      input.targetToolCallId === targetToolCallId &&
      input.targetToolName === targetToolName
    ) ||
    state.actions.some(
      (action) =>
        action.type === 'confirmation' &&
        action.targetToolCallId === targetToolCallId &&
        action.targetToolName === targetToolName,
    )
  );
}

export function createReadingSetupActivationService(options: {
  db: Database;
  manifest: ReadingManifest;
  sessionId: string;
  runId: string;
  state: AgentSessionState;
  input: AgentRunInput;
}) {
  return {
    async complete(
      toolCallId: string,
      trialToolCallId: string,
    ): Promise<CompleteReadingSetupResult> {
      const placeholderNode = options.manifest.nodes
        .filter((node) => node.tailoringEligible)
        .sort((left, right) => left.order - right.order)[0];
      if (!placeholderNode) throw new Error('书籍没有可裁读节点');

      return options.db.transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(readingSetupSessions)
          .where(eq(readingSetupSessions.id, options.sessionId))
          .for('update')
          .limit(1);
        if (!session || session.activeRunId !== options.runId) {
          throw new Error('Reading Setup run 已失效');
        }
        const [book] = await tx
          .select()
          .from(userBooks)
          .where(eq(userBooks.id, session.userBookId))
          .for('update')
          .limit(1);
        if (!book || book.deletedAt) throw new Error('用户书籍不存在');

        const records = indexAgentTranscript(options.state.messages);
        const trialRecord = requireSuccessfulTool(
          records,
          trialToolCallId,
          'generate_trial_slice',
        );
        if (
          !hasConfirmation(
            options.state,
            options.input,
            trialToolCallId,
            'generate_trial_slice',
          )
        ) {
          throw new Error('试读尚未由用户确认');
        }
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
          !hasConfirmation(
            options.state,
            options.input,
            strategyRecord.toolCallId,
            'publish_strategy',
          )
        ) {
          throw new Error('试读使用的 strategy 尚未由用户确认');
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
        const trialResult = objectValue(trialRecord.result, 'trial result');
        if (trialResult.strategyToolCallId !== strategyRecord.toolCallId) {
          throw new Error('试读结果引用的 strategy 不一致');
        }
        if (book.workflowStatus === 'active_reading' && book.currentStrategyVersionId) {
          return {
            toolCallId,
            trialToolCallId,
            userBookId: book.id,
            workflowStatus: 'active_reading' as const,
            strategyVersionId: book.currentStrategyVersionId,
          };
        }
        if (book.workflowStatus !== 'on_shelf') {
          throw new Error('用户书籍状态已经变化');
        }
        const [readySharedBook] = await tx
          .select({ id: sharedBooks.id })
          .from(sharedBooks)
          .where(and(eq(sharedBooks.id, book.sharedBookId), eq(sharedBooks.status, 'ready')))
          .limit(1);
        if (!readySharedBook) throw new Error('共享书籍尚未就绪');

        const brief = objectValue(briefRecord.arguments, 'brief arguments')
          .brief as unknown as Briefing;
        const profile = objectValue(profileRecord.arguments, 'profile arguments')
          .profile as unknown as BookReaderProfile;
        const strategyCore = strategyArgs.strategy as ProposedStrategy;
        const summary = strategyArgs.summary;
        if (typeof summary !== 'string' || !summary.trim()) {
          throw new Error('strategy summary 无效');
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
        if (!interview) throw new Error('访谈结构外壳创建失败');

        const [profileVersionRow, draftVersionRow, strategyVersionRow] = await Promise.all([
          tx
            .select({
              next: sql<number>`coalesce(max(${bookReaderProfileVersions.version}), 0)::int + 1`,
            })
            .from(bookReaderProfileVersions)
            .where(eq(bookReaderProfileVersions.userBookId, book.id))
            .then((rows) => rows[0]),
          tx
            .select({
              next: sql<number>`coalesce(max(${strategyDraftVersions.version}), 0)::int + 1`,
            })
            .from(strategyDraftVersions)
            .where(eq(strategyDraftVersions.userBookId, book.id))
            .then((rows) => rows[0]),
          tx
            .select({
              next: sql<number>`coalesce(max(${strategyVersions.version}), 0)::int + 1`,
            })
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
        if (!savedProfile) throw new Error('书籍读者画像创建失败');
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
        if (!draft) throw new Error('阅读策略草稿创建失败');
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
        if (!formalStrategy) throw new Error('正式阅读策略创建失败');

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
        if (!activated) throw new Error('用户书籍状态已经变化');

        return {
          toolCallId,
          trialToolCallId,
          userBookId: book.id,
          workflowStatus: 'active_reading' as const,
          strategyVersionId: formalStrategy.id,
        };
      });
    },
  };
}
