import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  ReadingNodePreview,
  ReadingSetupStreamErrorCode,
  Strategy,
  StrategyReviewResponse,
  StrategyRevisionStreamEvent,
  SubmitStrategyFeedbackRequest,
  SubmitTrialFeedbackRequest,
} from '@readtailor/contracts';
import type {
  ReadingSetupStreamDelta,
  ReadingStrategy,
} from '@readtailor/agent-kit';
import {
  interviewMessages,
  interviewSessions,
  nodeGenerations,
  readingSetupOperations,
  strategyDraftVersions,
  trialRevisions,
  trialSegments,
  userBooks,
  type Database,
} from '@readtailor/database';
import type { BookService } from '../../books';
import type { ReadingSetupEngine } from '../../reading-setup-engine';
import type { OwnedUserBook } from '../context/setup-context';
import { ADJUSTMENT_LIMIT } from '../domain/reading-setup-state';
import { UserBookError } from '../errors';
import {
  ReadingSetupLeaseLostError,
  type createSetupOperationStore,
  type PreparedReadingSetupOperation,
  type ReadingSetupOperationClaim,
  type ReadingSetupOperationRow,
} from '../operations/setup-operation-store';

type RevisionTurnStreamDelta =
  | Extract<ReadingSetupStreamDelta, { type: 'speculative_reset' | 'draft_started' | 'strategy_delta' }>
  | {
      type: 'reading_node_added';
      speculativeEpoch: number;
      node: ReadingNodePreview;
    };

type StrategyRevisionStreamPayload = StrategyRevisionStreamEvent extends infer Event
  ? Event extends StrategyRevisionStreamEvent
    ? Omit<Event, 'userBookId' | 'operationId' | 'operationAttempt' | 'sequence'>
    : never
  : never;

type SetupContext = {
  owned: OwnedUserBook;
  context: Record<string, unknown> & { bookProfile: unknown };
};

type OperationStore = Pick<
  ReturnType<typeof createSetupOperationStore>,
  | 'resolve'
  | 'observeById'
  | 'prepareExecution'
  | 'startLeaseRenewal'
  | 'fail'
>;

export type StrategyRevisionServiceOptions = {
  db: Database;
  books: BookService;
  setupEngine: ReadingSetupEngine;
  operationStore: OperationStore;
  requestId?: string;
  getOwnedBook(userBookId: string): Promise<OwnedUserBook>;
  getSetupContext(userBookId: string): Promise<SetupContext>;
  createReadingNodeProjector(
    manifestValue: unknown,
    bookProfile: unknown,
  ): (
    candidate: { ordinal: number; sectionId: string; segment: number; reason: string },
    seen: Set<string>,
  ) => ReadingNodePreview;
  mapStrategy(value: ReadingStrategy): Strategy;
  loadStrategyState(userBookId: string, draftId: string): Promise<StrategyReviewResponse>;
  onUnexpectedFinalizationError?(
    error: unknown,
    source: 'strategy_feedback' | 'trial_feedback',
  ): void;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createStreamBridge<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const signal = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    push(item: T) {
      queue.push(item);
      signal();
    },
    end() {
      ended = true;
      signal();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

export function createStrategyRevisionService(options: StrategyRevisionServiceOptions) {
  const {
    db,
    books,
    setupEngine,
    operationStore,
    requestId,
    getOwnedBook,
    getSetupContext,
    createReadingNodeProjector,
    mapStrategy,
    loadStrategyState,
    onUnexpectedFinalizationError,
  } = options;

  const reviseFromFeedback = async (
    userBookId: string,
    params: {
      draft: StrategyReviewResponse['draft'];
      feedback: string;
      idempotencyKey: string;
      trialRevisionId?: string;
      operationClaim: ReadingSetupOperationClaim;
      assertLeaseActive(): void;
      onStream?: (delta: RevisionTurnStreamDelta) => void;
    },
  ): Promise<string> => {
    const setup = await getSetupContext(userBookId);
    const manifestValue = await books.getManifest(setup.owned.sharedBook.id);
    if (!manifestValue) throw new UserBookError('书籍阅读索引不存在', 409);
    const projectNode = createReadingNodeProjector(
      manifestValue,
      setup.context.bookProfile,
    );
    let streamedEpoch = 0;
    let streamedNodes = new Set<string>();
    const outcome = await setupEngine.runTurn({
      sessionId: setup.owned.userBook.currentInterviewSessionId!,
      phase: 'strategy_review',
      askedCount: 0,
      context: { ...setup.context, currentStrategy: params.draft },
      feedback: params.feedback,
      ...(requestId ? { requestId } : {}),
      ...(params.onStream ? {
        onStream: (delta: ReadingSetupStreamDelta) => {
          params.assertLeaseActive();
          if (delta.type === 'speculative_reset') {
            streamedEpoch = delta.speculativeEpoch;
            streamedNodes = new Set<string>();
            params.onStream?.(delta);
            return;
          }
          if (delta.speculativeEpoch < streamedEpoch) return;
          if (delta.type === 'draft_started' && delta.source === 'revision') {
            params.onStream?.(delta);
          } else if (delta.type === 'strategy_delta') {
            params.onStream?.(delta);
          } else if (delta.type === 'reading_node_added') {
            try {
              params.onStream?.({
                type: 'reading_node_added',
                speculativeEpoch: delta.speculativeEpoch,
                node: projectNode(delta, streamedNodes),
              });
            } catch (error) {
              if (!(error instanceof UserBookError)) throw error;
            }
          }
        },
      } : {}),
    });
    if (outcome.type !== 'revised') throw new UserBookError('处理方式修订失败', 503);
    const finalNodes = new Set<string>();
    outcome.strategy.trial_candidates.forEach((candidate, index) => projectNode({
      ordinal: index + 1,
      sectionId: candidate.section_id,
      segment: candidate.segment,
      reason: candidate.reason,
    }, finalNodes));
    params.assertLeaseActive();

    return db.transaction(async (tx) => {
      const [bookGate] = await tx
        .select()
        .from(userBooks)
        .where(eq(userBooks.id, userBookId))
        .limit(1);
      if (
        !bookGate
        || bookGate.currentStrategyDraftVersionId !== params.draft.id
        || bookGate.adjustmentCount >= ADJUSTMENT_LIMIT
      ) {
        throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
      }
      if (params.trialRevisionId) {
        if (
          bookGate.workflowStatus !== 'trial_review'
          || bookGate.currentTrialRevisionId !== params.trialRevisionId
        ) {
          throw new UserBookError('试读版本已经更新', 409);
        }
        const changedRevision = await tx
          .update(trialRevisions)
          .set({ status: 'superseded', supersededAt: new Date(), updatedAt: new Date() })
          .where(and(
            eq(trialRevisions.id, params.trialRevisionId),
            eq(trialRevisions.userBookId, userBookId),
            eq(trialRevisions.status, 'published'),
          ))
          .returning({ id: trialRevisions.id });
        if (changedRevision.length !== 1) throw new UserBookError('试读版本已经更新', 409);
        const sourceSegments = await tx
          .select({ id: trialSegments.id })
          .from(trialSegments)
          .where(eq(trialSegments.trialRevisionId, params.trialRevisionId));
        if (sourceSegments.length > 0) {
          await tx
            .update(nodeGenerations)
            .set({
              status: 'superseded',
              result: null,
              completedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(and(
              eq(nodeGenerations.userBookId, userBookId),
              eq(nodeGenerations.generationScope, 'trial'),
              inArray(nodeGenerations.trialSegmentId, sourceSegments.map((segment) => segment.id)),
              inArray(nodeGenerations.status, ['queued', 'generating', 'retrying', 'ready', 'failed']),
            ));
        }
      } else if (
        bookGate.workflowStatus !== 'strategy_review'
        || bookGate.currentTrialRevisionId
      ) {
        throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
      }
      const superseded = await tx
        .update(strategyDraftVersions)
        .set({ status: 'superseded', supersededAt: new Date() })
        .where(and(
          eq(strategyDraftVersions.id, params.draft.id),
          eq(strategyDraftVersions.userBookId, userBookId),
          eq(strategyDraftVersions.status, params.draft.status),
        ))
        .returning({ id: strategyDraftVersions.id });
      if (superseded.length !== 1) {
        throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
      }
      const profileId = bookGate.currentBookReaderProfileVersionId;
      if (!profileId) throw new UserBookError('本书画像不存在', 409);
      const sessionId = bookGate.currentInterviewSessionId;
      if (sessionId) {
        const [session] = await tx
          .select()
          .from(interviewSessions)
          .where(eq(interviewSessions.id, sessionId))
          .limit(1)
          .for('update');
        if (session) {
          const [messageSequence] = await tx
            .select({
              max: sql<number>`coalesce(max(${interviewMessages.sequence}), 0)`,
            })
            .from(interviewMessages)
            .where(eq(interviewMessages.interviewSessionId, sessionId));
          await tx.insert(interviewMessages).values({
            interviewSessionId: sessionId,
            sequence: Number(messageSequence?.max ?? 0) + 1,
            role: 'user',
            kind: 'feedback',
            content: params.feedback.trim(),
            payload: { strategyDraftVersionId: params.draft.id, feedback: params.feedback },
            idempotencyKey: params.idempotencyKey,
          });
          await tx
            .update(interviewSessions)
            .set({ conversationVersion: session.conversationVersion + 1, updatedAt: new Date() })
            .where(eq(interviewSessions.id, sessionId));
        }
      }
      const [draft] = await tx
        .insert(strategyDraftVersions)
        .values({
          userBookId,
          bookReaderProfileVersionId: profileId,
          version: params.draft.version + 1,
          status: 'draft',
          readingBriefing: params.draft.readingBriefing,
          userFacingSummary: outcome.publicStrategy,
          strategy: mapStrategy(outcome.strategy),
        })
        .returning();
      if (!draft) throw new Error('failed to save revised strategy');
      const updated = await tx
        .update(userBooks)
        .set({
          workflowStatus: 'strategy_review',
          currentStrategyDraftVersionId: draft.id,
          currentTrialRevisionId: null,
          adjustmentCount: sql`${userBooks.adjustmentCount} + 1`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(userBooks.id, userBookId),
          eq(userBooks.currentStrategyDraftVersionId, params.draft.id),
          sql`${userBooks.adjustmentCount} < ${ADJUSTMENT_LIMIT}`,
        ))
        .returning({ id: userBooks.id });
      if (updated.length !== 1) {
        throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
      }
      const completed = await tx
        .update(readingSetupOperations)
        .set({
          status: 'completed',
          leaseId: null,
          leaseClaimedAt: null,
          leaseExpiresAt: null,
          resultStrategyDraftVersionId: draft.id,
          resultTrialRevisionId: null,
          errorSummary: null,
          completedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(readingSetupOperations.id, params.operationClaim.operationId),
          eq(readingSetupOperations.status, 'running'),
          eq(readingSetupOperations.leaseId, params.operationClaim.leaseId),
          eq(readingSetupOperations.attemptCount, params.operationClaim.attemptCount),
          sql`${readingSetupOperations.leaseExpiresAt} > now()`,
          eq(readingSetupOperations.baseStrategyDraftVersionId, params.draft.id),
          params.trialRevisionId
            ? eq(readingSetupOperations.baseTrialRevisionId, params.trialRevisionId)
            : isNull(readingSetupOperations.baseTrialRevisionId),
        ))
        .returning({ id: readingSetupOperations.id });
      if (completed.length !== 1) throw new ReadingSetupLeaseLostError();
      return draft.id;
    }).catch((error: unknown) => {
      if (error instanceof UserBookError || error instanceof ReadingSetupLeaseLostError) {
        throw error;
      }
      try {
        onUnexpectedFinalizationError?.(
          error,
          params.trialRevisionId ? 'trial_feedback' : 'strategy_feedback',
        );
      } catch {
        // Logging must not replace the original finalization failure with a logger failure.
      }
      throw new UserBookError('处理方式保存失败，请重试', 503);
    });
  };

  const runPreparedOperation = async (
    prepared: PreparedReadingSetupOperation,
    onStream?: (delta: RevisionTurnStreamDelta) => void,
  ): Promise<string> => {
    const operation = prepared.operation;
    if (operation.kind !== 'strategy_revision') {
      throw new UserBookError('阅读准备操作类型不匹配', 409);
    }
    if (operation.status === 'completed') {
      if (!operation.resultStrategyDraftVersionId) {
        throw new UserBookError('阅读准备操作结果损坏', 409);
      }
      return operation.resultStrategyDraftVersionId;
    }
    if (!prepared.claim) {
      throw new UserBookError(operation.errorSummary ?? '阅读准备操作失败', 503);
    }
    if (operation.payload.source === 'strategy_approve') {
      throw new UserBookError('阅读准备操作载荷不匹配', 409);
    }

    const claim = prepared.claim;
    const lease = operationStore.startLeaseRenewal(claim);
    try {
      const current = await loadStrategyState(
        operation.userBookId,
        operation.baseStrategyDraftVersionId,
      );
      lease.assertActive();
      return await reviseFromFeedback(operation.userBookId, {
        draft: current.draft,
        feedback: operation.payload.feedback,
        idempotencyKey: operation.idempotencyKey,
        ...(operation.payload.source === 'trial_feedback'
          ? { trialRevisionId: operation.payload.trialRevisionId }
          : {}),
        operationClaim: claim,
        assertLeaseActive: () => lease.assertActive(),
        ...(onStream ? { onStream } : {}),
      });
    } catch (error) {
      if (!(error instanceof ReadingSetupLeaseLostError)) {
        const failed = await operationStore.fail(claim, error).catch(() => false);
        if (!failed) throw new ReadingSetupLeaseLostError();
      }
      throw error;
    } finally {
      lease.stop();
    }
  };

  const executeOperation = async (initialOperation: ReadingSetupOperationRow): Promise<void> => {
    const prepared = await operationStore.prepareExecution(initialOperation);
    try {
      await runPreparedOperation(prepared);
    } catch (error) {
      if (error instanceof ReadingSetupLeaseLostError) {
        throw new UserBookError('阅读准备操作已由新请求接管，请查询恢复状态', 409);
      }
      throw error;
    }
  };

  const createStreamEmitter = (
    operation: ReadingSetupOperationRow,
    operationAttempt: number,
  ) => {
    let sequence = 0;
    return (payload: StrategyRevisionStreamPayload): StrategyRevisionStreamEvent => ({
      userBookId: operation.userBookId,
      operationId: operation.id,
      operationAttempt,
      sequence: sequence += 1,
      ...payload,
    } as StrategyRevisionStreamEvent);
  };

  const streamOperation = async function* (
    initialOperation: ReadingSetupOperationRow,
  ): AsyncGenerator<StrategyRevisionStreamEvent> {
    if (initialOperation.status === 'running') {
      const observed = await operationStore.observeById(
        initialOperation.userBookId,
        initialOperation.id,
      );
      if (observed && !observed.leaseExpired) {
        throw new UserBookError('阅读准备操作仍在处理中，请查询恢复状态', 409);
      }
    }
    const prepared = await operationStore.prepareExecution(initialOperation, false);
    const operation = prepared.operation;
    if (operation.kind !== 'strategy_revision' || operation.payload.source === 'strategy_approve') {
      throw new UserBookError('阅读准备操作类型不匹配', 409);
    }
    const operationAttempt = prepared.claim?.attemptCount ?? operation.attemptCount;
    if (operationAttempt < 1) throw new UserBookError('阅读准备操作尚未开始', 409);
    const emit = createStreamEmitter(operation, operationAttempt);
    const bridge = createStreamBridge<StrategyRevisionStreamEvent>();
    let resultDraftId: string | undefined;
    let operationError: unknown;
    const running = runPreparedOperation(prepared, (delta) => {
      switch (delta.type) {
        case 'speculative_reset':
          bridge.push(emit({
            type: 'speculative_reset',
            speculativeEpoch: delta.speculativeEpoch,
            phase: 'strategy_review',
          }));
          break;
        case 'draft_started':
          bridge.push(emit({
            type: 'revision_started',
            speculativeEpoch: delta.speculativeEpoch,
            source: operation.source,
            baseDraftId: operation.baseStrategyDraftVersionId,
            baseTrialRevisionId: operation.baseTrialRevisionId,
          } as StrategyRevisionStreamPayload));
          break;
        case 'strategy_delta':
          bridge.push(emit({
            type: 'strategy_delta',
            speculativeEpoch: delta.speculativeEpoch,
            chars: delta.chars,
          }));
          break;
        case 'reading_node_added':
          bridge.push(emit({
            type: 'reading_node_added',
            speculativeEpoch: delta.speculativeEpoch,
            node: delta.node,
          }));
          break;
      }
    })
      .then((value) => {
        resultDraftId = value;
      })
      .catch((error: unknown) => {
        operationError = error;
      })
      .finally(() => bridge.end());

    for await (const event of bridge.drain()) yield event;
    await running;
    if (operationError) {
      const code: ReadingSetupStreamErrorCode = operationError instanceof ReadingSetupLeaseLostError
        ? 'lease_lost'
        : operationError instanceof UserBookError && operationError.statusCode < 500
          ? 'validation_failed'
          : 'agent_failed';
      yield emit({
        type: 'error',
        code,
        message: operationError instanceof UserBookError
          ? operationError.message
          : code === 'lease_lost'
            ? '阅读准备操作已由新的恢复请求接管。'
            : '处理方式修订失败，请稍后重试。',
      });
      return;
    }
    if (!resultDraftId) {
      yield emit({ type: 'error', code: 'internal_error', message: '处理方式修订结果缺失。' });
      return;
    }
    try {
      const strategy = await loadStrategyState(operation.userBookId, resultDraftId);
      yield emit({ type: 'revision_final', strategy });
    } catch {
      yield emit({
        type: 'error',
        code: 'internal_error',
        message: '修订已经完成，正在重新读取最终结果。',
      });
    }
  };

  const resolveStrategyFeedback = async (
    userBookId: string,
    input: SubmitStrategyFeedbackRequest,
  ) => {
    const strategyDraftVersionId = input.strategyDraftVersionId.toLowerCase();
    const feedback = input.feedback.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!UUID_RE.test(strategyDraftVersionId) || !feedback || !idempotencyKey) {
      throw new UserBookError('处理方式反馈请求无效', 400);
    }
    return operationStore.resolve(userBookId, {
      kind: 'strategy_revision',
      source: 'strategy_feedback',
      baseStrategyDraftVersionId: strategyDraftVersionId,
      baseTrialRevisionId: null,
      idempotencyKey,
      payload: {
        source: 'strategy_feedback',
        strategyDraftVersionId,
        feedback,
      },
    });
  };

  const resolveTrialFeedback = async (
    userBookId: string,
    input: SubmitTrialFeedbackRequest,
  ) => {
    const trialRevisionId = input.trialRevisionId.toLowerCase();
    const feedback = input.feedback.trim();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!UUID_RE.test(trialRevisionId) || !feedback || !idempotencyKey) {
      throw new UserBookError('试读反馈请求无效', 400);
    }
    await getOwnedBook(userBookId);
    const [revision] = await db
      .select({ strategyDraftVersionId: trialRevisions.strategyDraftVersionId })
      .from(trialRevisions)
      .where(and(
        eq(trialRevisions.id, trialRevisionId),
        eq(trialRevisions.userBookId, userBookId),
      ))
      .limit(1);
    if (!revision) throw new UserBookError('试读版本不存在', 404);
    return operationStore.resolve(userBookId, {
      kind: 'strategy_revision',
      source: 'trial_feedback',
      baseStrategyDraftVersionId: revision.strategyDraftVersionId,
      baseTrialRevisionId: trialRevisionId,
      idempotencyKey,
      payload: {
        source: 'trial_feedback',
        strategyDraftVersionId: revision.strategyDraftVersionId,
        trialRevisionId,
        feedback,
      },
    });
  };

  const streamStrategyFeedback = async function* (
    userBookId: string,
    input: SubmitStrategyFeedbackRequest,
  ): AsyncGenerator<StrategyRevisionStreamEvent> {
    const operation = await resolveStrategyFeedback(userBookId, input);
    yield* streamOperation(operation);
  };

  const streamTrialFeedback = async function* (
    userBookId: string,
    input: SubmitTrialFeedbackRequest,
  ): AsyncGenerator<StrategyRevisionStreamEvent> {
    const operation = await resolveTrialFeedback(userBookId, input);
    yield* streamOperation(operation);
  };

  return {
    reviseFromFeedback,
    runPreparedOperation,
    executeOperation,
    createStreamEmitter,
    streamOperation,
    resolveStrategyFeedback,
    resolveTrialFeedback,
    streamStrategyFeedback,
    streamTrialFeedback,
  };
}
