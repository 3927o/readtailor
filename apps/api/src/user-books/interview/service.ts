import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type {
  InterviewQuestion,
  InterviewStateResponse,
  InterviewStreamEvent,
  ReaderProfile,
  ReadingNodePreview,
  ReadingSetupStreamErrorCode,
  Strategy,
  StrategyReviewResponse,
  SubmitInterviewAnswerRequest,
} from '@readtailor/contracts';
import type {
  ReaderProfilePatch,
  ReadingSetupStreamDelta,
  ReadingStrategy,
} from '@readtailor/agent-kit';
import {
  bookReaderProfileVersions,
  interviewAnswers,
  interviewMessages,
  interviewSessions,
  readerProfiles,
  readerProfileVersions,
  strategyDraftVersions,
  userBooks,
  type Database,
} from '@readtailor/database';
import type { BookService } from '../../books';
import type { ReadingSetupEngine } from '../../reading-setup-engine';
import type { OwnedUserBook } from '../context/setup-context';
import { UserBookError } from '../errors';
import {
  createInterviewCompletionStore,
  InterviewCompletionCheckpointError,
} from './completion-checkpoint-store';
import {
  mapInterviewBookReaderProfile,
  mapInterviewBriefing,
  mapInterviewQuestion,
  projectInterviewState,
} from './projection';

export type InterviewTurnClaim = {
  sessionId: string;
  leaseId: string;
  questionCount: number;
  conversationVersion: number;
};

type InterviewTurnStreamDelta =
  | Exclude<ReadingSetupStreamDelta, { type: 'reading_node_added' }>
  | {
      type: 'reading_node_added';
      speculativeEpoch: number;
      node: ReadingNodePreview;
    };

type InterviewStreamPayload = InterviewStreamEvent extends infer Event
  ? Event extends InterviewStreamEvent
    ? Omit<Event, 'userBookId' | 'streamId' | 'sequence'>
    : never
  : never;

type SetupContext = {
  owned: OwnedUserBook;
  context: Record<string, unknown> & { bookProfile: unknown };
};

export type InterviewServiceOptions = {
  db: Database;
  books: BookService;
  setupEngine: ReadingSetupEngine;
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
  applyReaderProfilePatch(profile: ReaderProfile, patch: ReaderProfilePatch): ReaderProfile;
  loadStrategyState(userBookId: string, draftId: string): Promise<StrategyReviewResponse>;
};

class InterviewTurnLeaseLostError extends Error {
  constructor() {
    super('interview turn lease lost');
    this.name = 'InterviewTurnLeaseLostError';
  }
}

const INTERVIEW_TURN_LEASE_SQL = sql`interval '6 minutes'`;
const INTERVIEW_TURN_RENEW_INTERVAL_MS = 60_000;
const emptyTurnLease = {
  turnLeaseId: null,
  turnLeaseVersion: null,
  turnLeaseClaimedAt: null,
  turnLeaseExpiresAt: null,
} as const;

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

export function createInterviewService(options: InterviewServiceOptions) {
  const {
    db,
    books,
    setupEngine,
    requestId,
    getOwnedBook,
    getSetupContext,
    createReadingNodeProjector,
    mapStrategy,
    applyReaderProfilePatch,
    loadStrategyState,
  } = options;

  const claimTurn = async (sessionId: string): Promise<InterviewTurnClaim | null> => {
    const leaseId = randomUUID();
    const [claimed] = await db
      .update(interviewSessions)
      .set({
        turnLeaseId: leaseId,
        turnLeaseVersion: sql`${interviewSessions.conversationVersion}`,
        turnLeaseClaimedAt: sql`now()`,
        turnLeaseExpiresAt: sql`now() + ${INTERVIEW_TURN_LEASE_SQL}`,
        updatedAt: new Date(),
      })
      .where(and(
        eq(interviewSessions.id, sessionId),
        eq(interviewSessions.status, 'active'),
        sql`${interviewSessions.conversationVersion} = ${interviewSessions.questionCount} * 2`,
        or(
          isNull(interviewSessions.turnLeaseId),
          sql`${interviewSessions.turnLeaseExpiresAt} <= now()`,
        ),
      ))
      .returning({
        sessionId: interviewSessions.id,
        questionCount: interviewSessions.questionCount,
        conversationVersion: interviewSessions.conversationVersion,
      });
    return claimed ? { ...claimed, leaseId } : null;
  };

  const releaseTurn = async (claim: InterviewTurnClaim) => {
    await db
      .update(interviewSessions)
      .set({ ...emptyTurnLease, updatedAt: new Date() })
      .where(and(
        eq(interviewSessions.id, claim.sessionId),
        eq(interviewSessions.turnLeaseId, claim.leaseId),
        eq(interviewSessions.turnLeaseVersion, claim.conversationVersion),
      ));
  };

  const renewTurn = async (claim: InterviewTurnClaim) => {
    const [renewed] = await db
      .update(interviewSessions)
      .set({
        turnLeaseExpiresAt: sql`now() + ${INTERVIEW_TURN_LEASE_SQL}`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(interviewSessions.id, claim.sessionId),
        eq(interviewSessions.status, 'active'),
        eq(interviewSessions.turnLeaseId, claim.leaseId),
        eq(interviewSessions.turnLeaseVersion, claim.conversationVersion),
        sql`${interviewSessions.turnLeaseExpiresAt} > now()`,
      ))
      .returning({ id: interviewSessions.id });
    return Boolean(renewed);
  };

  const startTurnLeaseRenewal = (claim: InterviewTurnClaim) => {
    let stopped = false;
    let lost = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (stopped) return;
        try {
          lost = !(await renewTurn(claim));
        } catch {
          lost = true;
        }
        if (!lost && !stopped) schedule();
      }, INTERVIEW_TURN_RENEW_INTERVAL_MS);
      timer.unref?.();
    };
    schedule();
    return {
      assertActive() {
        if (lost) throw new InterviewTurnLeaseLostError();
      },
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  };

  const saveSetupOutcome = async (
    userBookId: string,
    outcome: Awaited<ReturnType<ReadingSetupEngine['runTurn']>>,
    claim: InterviewTurnClaim,
  ) => {
    if (outcome.type === 'question') {
      const committed = await db.transaction(async (tx) => {
        const sequence = claim.conversationVersion + 1;
        const advanced = await tx
          .update(interviewSessions)
          .set({
            questionCount: claim.questionCount + 1,
            conversationVersion: sequence,
            ...emptyTurnLease,
            updatedAt: new Date(),
          })
          .where(and(
            eq(interviewSessions.id, claim.sessionId),
            eq(interviewSessions.status, 'active'),
            eq(interviewSessions.questionCount, claim.questionCount),
            eq(interviewSessions.conversationVersion, claim.conversationVersion),
            eq(interviewSessions.turnLeaseId, claim.leaseId),
            eq(interviewSessions.turnLeaseVersion, claim.conversationVersion),
            sql`${interviewSessions.turnLeaseExpiresAt} > now()`,
          ))
          .returning({ id: interviewSessions.id });
        if (advanced.length !== 1) return false;
        await tx.insert(interviewMessages).values({
          interviewSessionId: claim.sessionId,
          sequence,
          role: 'assistant',
          kind: 'question',
          content: outcome.question.prompt,
          payload: mapInterviewQuestion(outcome.question),
        });
        return true;
      });
      return { committed };
    }
    if (outcome.type !== 'completed') {
      throw new Error('unexpected reading setup outcome during interview');
    }
    const draftId = await db.transaction(async (tx) => {
      const completed = await tx
        .update(interviewSessions)
        .set({
          status: 'completed',
          completedAt: new Date(),
          ...emptyTurnLease,
          updatedAt: new Date(),
        })
        .where(and(
          eq(interviewSessions.id, claim.sessionId),
          eq(interviewSessions.status, 'active'),
          eq(interviewSessions.questionCount, claim.questionCount),
          eq(interviewSessions.conversationVersion, claim.conversationVersion),
          eq(interviewSessions.turnLeaseId, claim.leaseId),
          eq(interviewSessions.turnLeaseVersion, claim.conversationVersion),
          sql`${interviewSessions.turnLeaseExpiresAt} > now()`,
        ))
        .returning({ id: interviewSessions.id });
      if (completed.length !== 1) return null;
      const [profile] = await tx
        .insert(bookReaderProfileVersions)
        .values({
          userBookId,
          interviewSessionId: claim.sessionId,
          version: 1,
          profile: mapInterviewBookReaderProfile(outcome.bookReaderProfile),
        })
        .returning();
      if (!profile) throw new Error('failed to save book reader profile');
      const [draft] = await tx
        .insert(strategyDraftVersions)
        .values({
          userBookId,
          bookReaderProfileVersionId: profile.id,
          version: 1,
          status: 'draft',
          readingBriefing: mapInterviewBriefing(outcome.briefing),
          userFacingSummary: outcome.publicStrategy,
          strategy: mapStrategy(outcome.strategy),
        })
        .returning();
      if (!draft) throw new Error('failed to save strategy draft');
      if (outcome.readerProfilePatch) {
        const [book] = await tx
          .select({ userId: userBooks.userId })
          .from(userBooks)
          .where(eq(userBooks.id, userBookId))
          .limit(1);
        const [reader] = book
          ? await tx
              .select({ profile: readerProfiles, version: readerProfileVersions })
              .from(readerProfiles)
              .innerJoin(readerProfileVersions, eq(readerProfileVersions.id, readerProfiles.currentVersionId))
              .where(eq(readerProfiles.userId, book.userId))
              .limit(1)
          : [];
        if (reader) {
          const nextProfile = applyReaderProfilePatch(
            reader.version.profile,
            outcome.readerProfilePatch,
          );
          const [nextVersion] = await tx
            .insert(readerProfileVersions)
            .values({
              readerProfileId: reader.profile.id,
              version: reader.version.version + 1,
              profile: nextProfile,
              changeSource: 'interview',
            })
            .returning();
          if (nextVersion) {
            await tx
              .update(readerProfiles)
              .set({ currentVersionId: nextVersion.id, updatedAt: new Date() })
              .where(eq(readerProfiles.id, reader.profile.id));
          }
        }
      }
      const activated = await tx
        .update(userBooks)
        .set({
          workflowStatus: 'strategy_review',
          currentBookReaderProfileVersionId: profile.id,
          currentStrategyDraftVersionId: draft.id,
          updatedAt: new Date(),
        })
        .where(and(eq(userBooks.id, userBookId), eq(userBooks.workflowStatus, 'interviewing')))
        .returning({ id: userBooks.id });
      if (activated.length !== 1) throw new UserBookError('访谈状态已经变化', 409);
      return draft.id;
    });
    return { committed: draftId !== null, ...(draftId ? { draftId } : {}) };
  };

  const generateNextQuestion = async (
    userBookId: string,
    claim: InterviewTurnClaim,
    onStream?: (delta: InterviewTurnStreamDelta) => void,
  ) => {
    const lease = startTurnLeaseRenewal(claim);
    try {
      const setup = await getSetupContext(userBookId);
      const manifestValue = await books.getManifest(setup.owned.sharedBook.id);
      if (!manifestValue) throw new UserBookError('书籍阅读索引不存在', 409);
      const projectNode = createReadingNodeProjector(
        manifestValue,
        setup.context.bookProfile,
      );
      const completionStore = createInterviewCompletionStore({
        db,
        claim,
        validateCandidates: (candidates) => {
          const seen = new Set<string>();
          candidates.forEach((candidate, index) => projectNode({
            ordinal: index + 1,
            sectionId: candidate.section_id,
            segment: candidate.segment,
            reason: candidate.reason,
          }, seen));
        },
      });
      let streamedEpoch = 0;
      let streamedNodes = new Set<string>();
      const outcome = await setupEngine.runTurn({
        sessionId: claim.sessionId,
        phase: 'interviewing',
        askedCount: claim.questionCount,
        conversationVersion: claim.conversationVersion,
        context: setup.context,
        completionStore,
        ...(requestId ? { requestId } : {}),
        ...(onStream ? {
          onStream: (delta: ReadingSetupStreamDelta) => {
            lease.assertActive();
            if (delta.type === 'speculative_reset') {
              streamedEpoch = delta.speculativeEpoch;
              streamedNodes = new Set<string>();
              onStream(delta);
              return;
            }
            if (delta.speculativeEpoch < streamedEpoch) return;
            if (delta.type === 'reading_node_added') {
              try {
                onStream({
                  type: 'reading_node_added',
                  speculativeEpoch: delta.speculativeEpoch,
                  node: projectNode(delta, streamedNodes),
                });
              } catch (error) {
                if (!(error instanceof UserBookError)) throw error;
              }
              return;
            }
            onStream(delta);
          },
        } : {}),
      });
      lease.assertActive();
      if (outcome.type === 'completed') {
        const finalNodes = new Set<string>();
        outcome.strategy.trial_candidates.forEach((candidate, index) => projectNode({
          ordinal: index + 1,
          sectionId: candidate.section_id,
          segment: candidate.segment,
          reason: candidate.reason,
        }, finalNodes));
      }
      const saved = await saveSetupOutcome(userBookId, outcome, claim);
      if (!saved.committed) throw new InterviewTurnLeaseLostError();
      return { outcome, ...saved };
    } catch (error) {
      try {
        await releaseTurn(claim);
      } catch {
        // Lease expiry remains the crash-safe fallback when explicit release fails.
      }
      throw error;
    } finally {
      lease.stop();
    }
  };

  const ensureSession = async (userBookId: string) => {
    const owned = await getOwnedBook(userBookId);
    if (owned.sharedBook.status !== 'ready') {
      throw new UserBookError('书籍尚未处理完成', 409);
    }
    if (!['on_shelf', 'interviewing'].includes(owned.userBook.workflowStatus)) {
      throw new UserBookError('当前阶段不能开始访谈', 409);
    }
    let sessionId = owned.userBook.currentInterviewSessionId;
    if (!sessionId) {
      await db
        .insert(interviewSessions)
        .values({ userBookId })
        .onConflictDoNothing({ target: interviewSessions.userBookId });
      const [session] = await db
        .select()
        .from(interviewSessions)
        .where(eq(interviewSessions.userBookId, userBookId))
        .limit(1);
      if (!session) throw new UserBookError('访谈初始化失败', 503);
      sessionId = session.id;
      await db
        .update(userBooks)
        .set({
          workflowStatus: 'interviewing',
          currentInterviewSessionId: session.id,
          updatedAt: new Date(),
        })
        .where(and(
          eq(userBooks.id, userBookId),
          inArray(userBooks.workflowStatus, ['on_shelf', 'interviewing']),
        ));
    }
    return sessionId;
  };

  const resumePendingTurn = async (userBookId: string, sessionId: string) => {
    const claim = await claimTurn(sessionId);
    if (!claim) return false;
    await generateNextQuestion(userBookId, claim);
    return true;
  };

  const state = async (userBookId: string): Promise<InterviewStateResponse> => {
    const owned = await getOwnedBook(userBookId);
    const sessionId = owned.userBook.currentInterviewSessionId;
    if (!sessionId) throw new UserBookError('访谈尚未建立', 409);
    const [session, messages, answers] = await Promise.all([
      db
        .select()
        .from(interviewSessions)
        .where(eq(interviewSessions.id, sessionId))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select()
        .from(interviewMessages)
        .where(eq(interviewMessages.interviewSessionId, sessionId))
        .orderBy(asc(interviewMessages.sequence)),
      db
        .select({ answer: interviewAnswers, question: interviewMessages })
        .from(interviewAnswers)
        .innerJoin(interviewMessages, eq(interviewMessages.id, interviewAnswers.questionMessageId))
        .where(eq(interviewAnswers.interviewSessionId, sessionId))
        .orderBy(asc(interviewAnswers.createdAt)),
    ]);
    if (!session) throw new UserBookError('访谈不存在', 404);
    return projectInterviewState({ session, messages, answers });
  };

  const commitAnswer = async (
    userBookId: string,
    input: SubmitInterviewAnswerRequest,
  ): Promise<{ inserted: boolean; sessionId: string; claim?: InterviewTurnClaim }> => {
    const owned = await getOwnedBook(userBookId);
    const sessionId = owned.userBook.currentInterviewSessionId;
    if (owned.userBook.workflowStatus !== 'interviewing' || !sessionId) {
      throw new UserBookError('当前没有可回答的问题', 409);
    }
    const normalizedFreeText = input.freeText?.trim() || null;
    const selected = new Set(input.selectedOptionIds);
    return db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(interviewSessions)
        .where(eq(interviewSessions.id, sessionId))
        .limit(1)
        .for('update');
      if (!session || session.status !== 'active') {
        throw new UserBookError('访谈状态已经变化', 409);
      }

      const [existing] = await tx
        .select()
        .from(interviewAnswers)
        .where(and(
          eq(interviewAnswers.interviewSessionId, sessionId),
          eq(interviewAnswers.idempotencyKey, input.idempotencyKey),
        ))
        .limit(1);
      if (existing) {
        const [existingQuestion] = await tx
          .select()
          .from(interviewMessages)
          .where(eq(interviewMessages.id, existing.questionMessageId))
          .limit(1);
        if (
          String(existingQuestion?.payload.id ?? '') !== input.questionId
          || !isDeepStrictEqual(existing.selectedOptionIds, input.selectedOptionIds)
          || existing.freeText !== normalizedFreeText
        ) {
          throw new UserBookError('幂等键已用于不同的访谈回答', 409);
        }
        return { inserted: false, sessionId };
      }

      const [questionMessage] = await tx
        .select()
        .from(interviewMessages)
        .where(and(
          eq(interviewMessages.interviewSessionId, sessionId),
          eq(interviewMessages.kind, 'question'),
        ))
        .orderBy(desc(interviewMessages.sequence))
        .limit(1);
      if (
        !questionMessage
        || questionMessage.sequence !== session.conversationVersion
        || String(questionMessage.payload.id ?? '') !== input.questionId
      ) {
        throw new UserBookError('问题已经更新，请刷新后继续', 409);
      }
      const [answered] = await tx
        .select({ id: interviewAnswers.id })
        .from(interviewAnswers)
        .where(eq(interviewAnswers.questionMessageId, questionMessage.id))
        .limit(1);
      if (answered) throw new UserBookError('问题已经回答，请刷新后继续', 409);

      const question = questionMessage.payload as unknown as InterviewQuestion;
      if (input.selectedOptionIds.some((id) => (
        !question.options.some((option) => option.id === id)
      ))) {
        throw new UserBookError('回答包含无效选项', 400);
      }
      if (selected.size === 0 && !normalizedFreeText) {
        throw new UserBookError('请选择一个选项或填写补充内容', 400);
      }

      await tx.insert(interviewAnswers).values({
        interviewSessionId: sessionId,
        questionMessageId: questionMessage.id,
        selectedOptionIds: input.selectedOptionIds,
        freeText: normalizedFreeText,
        idempotencyKey: input.idempotencyKey,
      });
      const labels = question.options
        .filter((option) => selected.has(option.id))
        .map((option) => option.label);
      const content = [...labels, normalizedFreeText].filter(Boolean).join('；');
      const conversationVersion = session.conversationVersion + 1;
      await tx.insert(interviewMessages).values({
        interviewSessionId: sessionId,
        sequence: conversationVersion,
        role: 'user',
        kind: 'answer',
        content,
        payload: input,
      });
      const leaseId = randomUUID();
      await tx
        .update(interviewSessions)
        .set({
          conversationVersion,
          turnLeaseId: leaseId,
          turnLeaseVersion: conversationVersion,
          turnLeaseClaimedAt: sql`now()`,
          turnLeaseExpiresAt: sql`now() + ${INTERVIEW_TURN_LEASE_SQL}`,
          updatedAt: new Date(),
        })
        .where(eq(interviewSessions.id, sessionId));
      return {
        inserted: true,
        sessionId,
        claim: {
          sessionId,
          leaseId,
          questionCount: session.questionCount,
          conversationVersion,
        },
      };
    });
  };

  const createStreamEmitter = (userBookId: string, streamId: string) => {
    let sequence = 0;
    return (payload: InterviewStreamPayload): InterviewStreamEvent => ({
      userBookId,
      streamId,
      sequence: sequence += 1,
      ...payload,
    } as InterviewStreamEvent);
  };

  const terminalEvents = async function* (
    userBookId: string,
    emit: (payload: InterviewStreamPayload) => InterviewStreamEvent,
  ): AsyncGenerator<InterviewStreamEvent> {
    const owned = await getOwnedBook(userBookId);
    if (owned.userBook.workflowStatus !== 'interviewing') {
      yield emit({ type: 'done', workflowStatus: owned.userBook.workflowStatus });
      return;
    }
    const currentState = await state(userBookId);
    if (currentState.currentQuestion) {
      yield emit({
        type: 'question_final',
        question: currentState.currentQuestion,
        ordinal: Math.max(1, Math.min(currentState.maxQuestions, currentState.questionCount)),
        maxQuestions: currentState.maxQuestions,
      });
    } else {
      yield emit({ type: 'done', workflowStatus: owned.userBook.workflowStatus });
    }
  };

  const streamClaimedTurn = async function* (
    userBookId: string,
    claim: InterviewTurnClaim,
  ): AsyncGenerator<InterviewStreamEvent> {
    const emit = createStreamEmitter(userBookId, claim.leaseId);
    const bridge = createStreamBridge<InterviewStreamEvent>();
    let result: Awaited<ReturnType<typeof generateNextQuestion>> | undefined;
    let turnError: unknown;
    const running = generateNextQuestion(userBookId, claim, (delta) => {
      switch (delta.type) {
        case 'speculative_reset':
          bridge.push(emit({
            type: 'speculative_reset',
            speculativeEpoch: delta.speculativeEpoch,
            phase: 'interviewing',
          }));
          break;
        case 'ack_delta':
        case 'prompt_delta':
        case 'hint_delta':
        case 'strategy_delta':
          bridge.push(emit({
            type: delta.type,
            speculativeEpoch: delta.speculativeEpoch,
            chars: delta.chars,
          }));
          break;
        case 'option_added':
          bridge.push(emit({
            type: delta.type,
            speculativeEpoch: delta.speculativeEpoch,
            id: delta.id,
            label: delta.label,
          }));
          break;
        case 'sufficiency':
          bridge.push(emit({
            type: delta.type,
            speculativeEpoch: delta.speculativeEpoch,
            value: delta.value,
          }));
          break;
        case 'draft_started':
          if (delta.source === 'interview') {
            bridge.push(emit({
              type: delta.type,
              speculativeEpoch: delta.speculativeEpoch,
              conversationVersion: claim.conversationVersion,
            }));
          }
          break;
        case 'briefing_delta':
          bridge.push(emit({
            type: delta.type,
            speculativeEpoch: delta.speculativeEpoch,
            field: delta.field,
            chars: delta.chars,
          }));
          break;
        case 'reading_node_added':
          bridge.push(emit({
            type: delta.type,
            speculativeEpoch: delta.speculativeEpoch,
            node: delta.node,
          }));
          break;
        case 'selection_started':
        case 'fragment_added':
          break;
      }
    })
      .then((value) => {
        result = value;
      })
      .catch((error: unknown) => {
        turnError = error;
      })
      .finally(() => bridge.end());

    for await (const event of bridge.drain()) yield event;
    await running;
    if (turnError) {
      const leaseLost = turnError instanceof InterviewTurnLeaseLostError
        || (turnError instanceof InterviewCompletionCheckpointError && turnError.code === 'lease_lost');
      const code: ReadingSetupStreamErrorCode = leaseLost
        ? 'lease_lost'
        : turnError instanceof UserBookError
          ? 'validation_failed'
          : 'agent_failed';
      yield emit({
        type: 'error',
        code,
        message: turnError instanceof UserBookError
          ? turnError.message
          : code === 'lease_lost'
            ? '访谈处理已由新的恢复请求接管。'
            : '生成下一步时出错，请稍后重试。',
      });
      return;
    }
    if (!result) {
      yield emit({ type: 'error', code: 'internal_error', message: '访谈处理结果缺失。' });
      return;
    }
    if (result.outcome.type === 'completed') {
      if (!result.draftId) {
        yield emit({ type: 'error', code: 'internal_error', message: '处理方式草稿结果缺失。' });
        return;
      }
      const strategy = await loadStrategyState(userBookId, result.draftId);
      yield emit({ type: 'draft_final', strategy });
    }
    yield* terminalEvents(userBookId, emit);
  };

  const start = async (userBookId: string): Promise<InterviewStateResponse> => {
    const sessionId = await ensureSession(userBookId);
    await resumePendingTurn(userBookId, sessionId);
    return state(userBookId);
  };

  const resume = async (userBookId: string): Promise<InterviewStateResponse> => {
    const owned = await getOwnedBook(userBookId);
    const sessionId = owned.userBook.currentInterviewSessionId;
    if (owned.userBook.workflowStatus !== 'interviewing' || !sessionId) {
      throw new UserBookError('当前访谈不需要恢复', 409);
    }
    await resumePendingTurn(userBookId, sessionId);
    return state(userBookId);
  };

  const streamResume = async function* (
    userBookId: string,
  ): AsyncGenerator<InterviewStreamEvent> {
    const owned = await getOwnedBook(userBookId);
    const sessionId = owned.userBook.currentInterviewSessionId;
    if (owned.userBook.workflowStatus !== 'interviewing' || !sessionId) {
      throw new UserBookError('当前访谈不需要恢复', 409);
    }
    const claim = await claimTurn(sessionId);
    if (!claim) throw new UserBookError('访谈仍在处理中', 409);
    yield* streamClaimedTurn(userBookId, claim);
  };

  const streamAnswer = async function* (
    userBookId: string,
    input: SubmitInterviewAnswerRequest,
  ): AsyncGenerator<InterviewStreamEvent> {
    const committed = await commitAnswer(userBookId, input);
    const claim = committed.claim ?? await claimTurn(committed.sessionId);
    if (claim) {
      yield* streamClaimedTurn(userBookId, claim);
      return;
    }
    yield* terminalEvents(
      userBookId,
      createStreamEmitter(userBookId, randomUUID()),
    );
  };

  return {
    claimTurn,
    releaseTurn,
    renewTurn,
    startTurnLeaseRenewal,
    saveSetupOutcome,
    generateNextQuestion,
    ensureSession,
    resumePendingTurn,
    state,
    commitAnswer,
    createStreamEmitter,
    terminalEvents,
    streamClaimedTurn,
    start,
    resume,
    streamResume,
    streamAnswer,
  };
}
