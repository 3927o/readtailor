import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type {
  ReadingSetupOperationKind,
  ReadingSetupOperationPayload,
  ReadingSetupOperationResponse,
  ReadingSetupOperationSource,
} from '@readtailor/contracts';
import {
  readingSetupOperations,
  strategyDraftVersions,
  trialRevisions,
  userBooks,
  type Database,
} from '@readtailor/database';
import { readingSetupOperationRequestHash } from '../domain/reading-setup-operation';
import {
  ADJUSTMENT_LIMIT,
  isCurrentStrategyDraftReview,
  isCurrentTrialReview,
} from '../domain/reading-setup-state';
import { UserBookError } from '../errors';
import { projectReadingSetupOperation as mapReadingSetupOperation } from '../projections/reading-setup-operation';

export type ReadingSetupOperationClaim = {
  operationId: string;
  leaseId: string;
  attemptCount: number;
};

export type ReadingSetupOperationCommand = {
  kind: ReadingSetupOperationKind;
  source: ReadingSetupOperationSource;
  baseStrategyDraftVersionId: string;
  baseTrialRevisionId: string | null;
  idempotencyKey: string;
  payload: ReadingSetupOperationPayload;
};

export type ReadingSetupOperationRow = typeof readingSetupOperations.$inferSelect;

export type ReadingSetupOperationObservation = {
  operation: ReadingSetupOperationRow;
  leaseExpired: boolean;
};

export type PreparedReadingSetupOperation = {
  operation: ReadingSetupOperationRow;
  claim: ReadingSetupOperationClaim | null;
};

export class ReadingSetupLeaseLostError extends Error {
  constructor() {
    super('reading setup operation lease lost');
    this.name = 'ReadingSetupLeaseLostError';
  }
}

class ReadingSetupClaimConflictError extends Error {
  constructor() {
    super('reading setup operation claim conflict');
    this.name = 'ReadingSetupClaimConflictError';
  }
}

type OwnedUserBook = {
  userBook: typeof userBooks.$inferSelect;
};

export type SetupOperationStoreOptions = {
  db: Database;
  getOwnedBook(userBookId: string): Promise<OwnedUserBook>;
};

const READING_SETUP_OPERATION_LEASE_SQL = sql`interval '6 minutes'`;
const READING_SETUP_OPERATION_RENEW_INTERVAL_MS = 60_000;

function postgresConstraintName(error: unknown): string | null {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const pg = candidate as { code?: unknown; constraint_name?: unknown };
    if (pg.code === '23505' && typeof pg.constraint_name === 'string') {
      return pg.constraint_name;
    }
  }
  return null;
}

export function createSetupOperationStore(options: SetupOperationStoreOptions) {
  const { db, getOwnedBook } = options;

  const readByIdempotencyKey = async (
    userBookId: string,
    idempotencyKey: string,
  ): Promise<ReadingSetupOperationRow | undefined> => db
    .select()
    .from(readingSetupOperations)
    .where(and(
      eq(readingSetupOperations.userBookId, userBookId),
      eq(readingSetupOperations.idempotencyKey, idempotencyKey),
    ))
    .limit(1)
    .then((rows) => rows[0]);

  const readById = async (
    userBookId: string,
    operationId: string,
  ): Promise<ReadingSetupOperationRow | undefined> => db
    .select()
    .from(readingSetupOperations)
    .where(and(
      eq(readingSetupOperations.id, operationId),
      eq(readingSetupOperations.userBookId, userBookId),
    ))
    .limit(1)
    .then((rows) => rows[0]);

  const observeById = async (
    userBookId: string,
    operationId: string,
  ): Promise<ReadingSetupOperationObservation | undefined> => db
    .select({
      operation: readingSetupOperations,
      leaseExpired: sql<boolean>`coalesce(${readingSetupOperations.leaseExpiresAt} <= now(), false)`,
    })
    .from(readingSetupOperations)
    .where(and(
      eq(readingSetupOperations.id, operationId),
      eq(readingSetupOperations.userBookId, userBookId),
    ))
    .limit(1)
    .then((rows) => rows[0]);

  const assertHash = (
    operation: ReadingSetupOperationRow,
    requestHash: string,
  ) => {
    if (operation.requestHash !== requestHash) {
      throw new UserBookError('幂等键已用于不同的阅读准备操作', 409);
    }
  };

  const validate = async (operation: ReadingSetupOperationRow) => {
    const owned = await getOwnedBook(operation.userBookId);
    const book = owned.userBook;
    if (book.currentStrategyDraftVersionId !== operation.baseStrategyDraftVersionId) {
      throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
    }
    const [draft] = await db
      .select({ status: strategyDraftVersions.status })
      .from(strategyDraftVersions)
      .where(and(
        eq(strategyDraftVersions.id, operation.baseStrategyDraftVersionId),
        eq(strategyDraftVersions.userBookId, operation.userBookId),
      ))
      .limit(1);
    if (!draft) throw new UserBookError('处理方式版本不存在', 404);

    if (operation.source === 'strategy_approve') {
      if (
        !isCurrentStrategyDraftReview(book, operation.baseStrategyDraftVersionId)
        || book.currentTrialRevisionId !== null
        || draft.status !== 'draft'
      ) {
        throw new UserBookError('处理方式已经确认或更新', 409);
      }
      return;
    }

    if (book.adjustmentCount >= ADJUSTMENT_LIMIT) {
      throw new UserBookError('已经达到 5 次调整上限', 409);
    }
    if (operation.source === 'strategy_feedback') {
      if (
        !isCurrentStrategyDraftReview(book, operation.baseStrategyDraftVersionId)
        || book.currentTrialRevisionId !== null
        || !['draft', 'approved_for_trial'].includes(draft.status)
      ) {
        throw new UserBookError('当前阶段不能修改处理方式', 409);
      }
      return;
    }

    if (
      !operation.baseTrialRevisionId
      || !isCurrentTrialReview(book, operation.baseTrialRevisionId)
    ) {
      throw new UserBookError('试读版本已经更新', 409);
    }
    const [revision] = await db
      .select({ status: trialRevisions.status })
      .from(trialRevisions)
      .where(and(
        eq(trialRevisions.id, operation.baseTrialRevisionId),
        eq(trialRevisions.userBookId, operation.userBookId),
      ))
      .limit(1);
    if (!revision || revision.status !== 'published') {
      throw new UserBookError('试读版本尚未发布或已经更新', 409);
    }
  };

  const resolve = async (
    userBookId: string,
    command: ReadingSetupOperationCommand,
  ): Promise<ReadingSetupOperationRow> => {
    await getOwnedBook(userBookId);
    const requestHash = readingSetupOperationRequestHash(command);
    const existing = await readByIdempotencyKey(userBookId, command.idempotencyKey);
    if (existing) {
      assertHash(existing, requestHash);
      return existing;
    }

    const candidate: ReadingSetupOperationRow = {
      id: randomUUID(),
      userBookId,
      kind: command.kind,
      source: command.source,
      baseStrategyDraftVersionId: command.baseStrategyDraftVersionId,
      baseTrialRevisionId: command.baseTrialRevisionId,
      idempotencyKey: command.idempotencyKey,
      requestHash,
      payload: command.payload,
      status: 'pending',
      attemptCount: 0,
      leaseId: null,
      leaseClaimedAt: null,
      leaseExpiresAt: null,
      resultStrategyDraftVersionId: null,
      resultTrialRevisionId: null,
      errorSummary: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      completedAt: null,
    };
    await validate(candidate);

    try {
      const [created] = await db
        .insert(readingSetupOperations)
        .values({
          id: candidate.id,
          userBookId,
          kind: command.kind,
          source: command.source,
          baseStrategyDraftVersionId: command.baseStrategyDraftVersionId,
          baseTrialRevisionId: command.baseTrialRevisionId,
          idempotencyKey: command.idempotencyKey,
          requestHash,
          payload: command.payload,
        })
        .returning();
      if (!created) throw new Error('failed to create reading setup operation');
      return created;
    } catch (error) {
      const constraint = postgresConstraintName(error);
      if (constraint === 'reading_setup_operations_book_idempotency_unique') {
        const raced = await readByIdempotencyKey(userBookId, command.idempotencyKey);
        if (!raced) throw error;
        assertHash(raced, requestHash);
        return raced;
      }
      if (constraint === 'reading_setup_operations_one_active_per_book') {
        throw new UserBookError('当前已有阅读准备操作正在进行', 409);
      }
      throw error;
    }
  };

  const claim = async (
    operation: ReadingSetupOperationRow,
  ): Promise<ReadingSetupOperationClaim> => {
    if (operation.status === 'completed') {
      throw new UserBookError('阅读准备操作已完成', 409);
    }
    await validate(operation);
    const leaseId = randomUUID();
    const attemptCount = operation.attemptCount + 1;
    const stateGate = operation.source === 'strategy_approve'
      ? sql`exists (
          select 1
          from ${userBooks}
          inner join ${strategyDraftVersions}
            on ${strategyDraftVersions.id} = ${userBooks.currentStrategyDraftVersionId}
          where ${userBooks.id} = ${operation.userBookId}
            and ${userBooks.workflowStatus} = 'strategy_review'
            and ${userBooks.currentStrategyDraftVersionId} = ${operation.baseStrategyDraftVersionId}
            and ${userBooks.currentTrialRevisionId} is null
            and ${strategyDraftVersions.status} = 'draft'
        )`
      : operation.source === 'strategy_feedback'
        ? sql`exists (
            select 1
            from ${userBooks}
            inner join ${strategyDraftVersions}
              on ${strategyDraftVersions.id} = ${userBooks.currentStrategyDraftVersionId}
            where ${userBooks.id} = ${operation.userBookId}
              and ${userBooks.workflowStatus} = 'strategy_review'
              and ${userBooks.currentStrategyDraftVersionId} = ${operation.baseStrategyDraftVersionId}
              and ${userBooks.currentTrialRevisionId} is null
              and ${userBooks.adjustmentCount} < ${ADJUSTMENT_LIMIT}
              and ${strategyDraftVersions.status} in ('draft', 'approved_for_trial')
          )`
        : sql`exists (
            select 1
            from ${userBooks}
            inner join ${trialRevisions}
              on ${trialRevisions.id} = ${userBooks.currentTrialRevisionId}
            where ${userBooks.id} = ${operation.userBookId}
              and ${userBooks.workflowStatus} = 'trial_review'
              and ${userBooks.currentStrategyDraftVersionId} = ${operation.baseStrategyDraftVersionId}
              and ${userBooks.currentTrialRevisionId} = ${operation.baseTrialRevisionId}
              and ${userBooks.adjustmentCount} < ${ADJUSTMENT_LIMIT}
              and ${trialRevisions.status} = 'published'
          )`;
    const [claimed] = await db
      .update(readingSetupOperations)
      .set({
        status: 'running',
        attemptCount,
        leaseId,
        leaseClaimedAt: sql`now()`,
        leaseExpiresAt: sql`now() + ${READING_SETUP_OPERATION_LEASE_SQL}`,
        resultStrategyDraftVersionId: null,
        resultTrialRevisionId: null,
        errorSummary: null,
        completedAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(readingSetupOperations.id, operation.id),
        eq(readingSetupOperations.attemptCount, operation.attemptCount),
        stateGate,
        or(
          eq(readingSetupOperations.status, 'pending'),
          eq(readingSetupOperations.status, 'failed'),
          and(
            eq(readingSetupOperations.status, 'running'),
            sql`${readingSetupOperations.leaseExpiresAt} <= now()`,
          ),
        ),
      ))
      .returning({ id: readingSetupOperations.id });
    if (!claimed) {
      const latest = await observeById(operation.userBookId, operation.id);
      if (
        latest
        && latest.operation.status === operation.status
        && latest.operation.attemptCount === operation.attemptCount
        && latest.operation.leaseId === operation.leaseId
      ) {
        await validate(operation);
      }
      throw new ReadingSetupClaimConflictError();
    }
    return { operationId: operation.id, leaseId, attemptCount };
  };

  const waitForOutcome = async (
    operation: ReadingSetupOperationRow,
  ): Promise<ReadingSetupOperationObservation> => {
    for (;;) {
      const observed = await observeById(operation.userBookId, operation.id);
      if (!observed) throw new UserBookError('阅读准备操作不存在', 404);
      if (
        observed.operation.status === 'completed'
        || observed.operation.status === 'failed'
        || (observed.operation.status === 'running' && observed.leaseExpired)
      ) {
        return observed;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  };

  const failUnclaimed = async (
    operation: ReadingSetupOperationRow,
    error: unknown,
  ) => {
    if (operation.status !== 'pending') return;
    const errorSummary = error instanceof UserBookError
      ? error.message
      : '阅读准备操作无法开始';
    await db
      .update(readingSetupOperations)
      .set({
        status: 'failed',
        errorSummary,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(readingSetupOperations.id, operation.id),
        eq(readingSetupOperations.status, 'pending'),
        eq(readingSetupOperations.attemptCount, operation.attemptCount),
        isNull(readingSetupOperations.leaseId),
      ));
  };

  const prepareExecution = async (
    initial: ReadingSetupOperationRow,
    waitForClaimConflict = true,
  ): Promise<PreparedReadingSetupOperation> => {
    let operation = initial;
    let observedInFlight = false;
    if (operation.status === 'running') {
      observedInFlight = true;
      operation = (await waitForOutcome(operation)).operation;
    }
    if (operation.status === 'completed' || (operation.status === 'failed' && observedInFlight)) {
      return { operation, claim: null };
    }
    try {
      return { operation, claim: await claim(operation) };
    } catch (error) {
      if (!(error instanceof ReadingSetupClaimConflictError)) {
        await failUnclaimed(operation, error).catch(() => {});
        throw error;
      }
      if (!waitForClaimConflict) {
        const observed = await observeById(operation.userBookId, operation.id);
        if (!observed) throw new UserBookError('阅读准备操作不存在', 404);
        if (observed.operation.status === 'completed' || observed.operation.status === 'failed') {
          return { operation: observed.operation, claim: null };
        }
        if (observed.operation.status === 'running' && !observed.leaseExpired) {
          throw new UserBookError('阅读准备操作仍在处理中，请查询恢复状态', 409);
        }
        return prepareExecution(observed.operation, false);
      }
      const settled = await waitForOutcome(operation);
      if (settled.operation.status === 'completed' || settled.operation.status === 'failed') {
        return { operation: settled.operation, claim: null };
      }
      return prepareExecution(settled.operation, true);
    }
  };

  const renew = async (claimValue: ReadingSetupOperationClaim) => {
    const [renewed] = await db
      .update(readingSetupOperations)
      .set({
        leaseExpiresAt: sql`now() + ${READING_SETUP_OPERATION_LEASE_SQL}`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(readingSetupOperations.id, claimValue.operationId),
        eq(readingSetupOperations.status, 'running'),
        eq(readingSetupOperations.leaseId, claimValue.leaseId),
        eq(readingSetupOperations.attemptCount, claimValue.attemptCount),
        sql`${readingSetupOperations.leaseExpiresAt} > now()`,
      ))
      .returning({ id: readingSetupOperations.id });
    return Boolean(renewed);
  };

  const startLeaseRenewal = (claimValue: ReadingSetupOperationClaim) => {
    let stopped = false;
    let lost = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (stopped) return;
        try {
          lost = !(await renew(claimValue));
        } catch {
          lost = true;
        }
        if (!lost && !stopped) schedule();
      }, READING_SETUP_OPERATION_RENEW_INTERVAL_MS);
      timer.unref?.();
    };
    schedule();
    return {
      assertActive() {
        if (lost) throw new ReadingSetupLeaseLostError();
      },
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  };

  const fail = async (
    claimValue: ReadingSetupOperationClaim,
    error: unknown,
  ) => {
    const rawSummary = error instanceof UserBookError
      ? error.message
      : '阅读准备操作失败';
    const errorSummary = rawSummary.trim() || '阅读准备操作失败';
    const [failed] = await db
      .update(readingSetupOperations)
      .set({
        status: 'failed',
        leaseId: null,
        leaseClaimedAt: null,
        leaseExpiresAt: null,
        resultStrategyDraftVersionId: null,
        resultTrialRevisionId: null,
        errorSummary,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(
        eq(readingSetupOperations.id, claimValue.operationId),
        eq(readingSetupOperations.status, 'running'),
        eq(readingSetupOperations.leaseId, claimValue.leaseId),
        eq(readingSetupOperations.attemptCount, claimValue.attemptCount),
        sql`${readingSetupOperations.leaseExpiresAt} > now()`,
      ))
      .returning({ id: readingSetupOperations.id });
    return Boolean(failed);
  };

  const project = (
    operation: ReadingSetupOperationRow,
    leaseExpired = false,
  ): ReadingSetupOperationResponse => {
    const projected = mapReadingSetupOperation(operation, leaseExpired);
    if (projected) return projected;
    throw new UserBookError('阅读准备操作结果损坏', 409);
  };

  const current = async (userBookId: string): Promise<ReadingSetupOperationResponse | null> => {
    const owned = await getOwnedBook(userBookId);
    if (![
      'strategy_review',
      'trial_generating',
      'trial_generation_failed',
      'trial_review',
    ].includes(owned.userBook.workflowStatus)) {
      return null;
    }
    const observations = await db
      .select({
        operation: readingSetupOperations,
        leaseExpired: sql<boolean>`coalesce(${readingSetupOperations.leaseExpiresAt} <= now(), false)`,
      })
      .from(readingSetupOperations)
      .where(eq(readingSetupOperations.userBookId, userBookId))
      .orderBy(desc(readingSetupOperations.updatedAt), desc(readingSetupOperations.id));
    const active = observations.find(({ operation }) => ['pending', 'running'].includes(operation.status));
    if (active) return project(active.operation, active.leaseExpired);

    const currentOperation = owned.userBook.workflowStatus === 'strategy_review'
      ? observations.find(({ operation }) => (
          operation.status === 'completed'
          && operation.resultStrategyDraftVersionId === owned.userBook.currentStrategyDraftVersionId
        ) || (
          operation.status === 'failed'
          && operation.baseStrategyDraftVersionId === owned.userBook.currentStrategyDraftVersionId
          && operation.baseTrialRevisionId === null
        ))
      : observations.find(({ operation }) => (
          operation.status === 'completed'
          && operation.resultTrialRevisionId === owned.userBook.currentTrialRevisionId
        ) || (
          operation.status === 'failed'
          && operation.baseTrialRevisionId === owned.userBook.currentTrialRevisionId
        ));
    return currentOperation
      ? project(currentOperation.operation, currentOperation.leaseExpired)
      : null;
  };

  return {
    readByIdempotencyKey,
    readById,
    observeById,
    validate,
    resolve,
    claim,
    waitForOutcome,
    failUnclaimed,
    prepareExecution,
    renew,
    startLeaseRenewal,
    fail,
    project,
    current,
  };
}
