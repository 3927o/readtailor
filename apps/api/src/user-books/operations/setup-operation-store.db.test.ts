import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readingSetupOperations, userBooks } from '@readtailor/database';
import {
  getTestDatabase,
  hasTestDatabase,
  strategyReviewGraph,
} from '../../test/database';
import { UserBookError } from '../errors';
import { createSetupOperationStore } from './setup-operation-store';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

function createStore() {
  const { db } = getTestDatabase();
  return createSetupOperationStore({
    db,
    async getOwnedBook(userBookId) {
      const [userBook] = await db
        .select()
        .from(userBooks)
        .where(eq(userBooks.id, userBookId))
        .limit(1);
      if (!userBook) throw new UserBookError('用户书籍不存在', 404);
      return { userBook };
    },
  });
}

describePostgres(`setup operation store${skipReason}`, () => {
  it('resolves idempotently and preserves failure recovery projection', async () => {
    const { db } = getTestDatabase();
    const graph = await strategyReviewGraph(db);
    const store = createStore();
    const command = {
      kind: 'strategy_revision' as const,
      source: 'strategy_feedback' as const,
      baseStrategyDraftVersionId: graph.strategyDraftVersionId,
      baseTrialRevisionId: null,
      idempotencyKey: 'strategy-feedback-1',
      payload: {
        source: 'strategy_feedback' as const,
        strategyDraftVersionId: graph.strategyDraftVersionId,
        feedback: '请更简洁',
      },
    };

    const initial = await store.resolve(graph.userBookId, command);
    const replay = await store.resolve(graph.userBookId, command);
    expect(replay.id).toBe(initial.id);
    await expect(store.resolve(graph.userBookId, {
      ...command,
      payload: { ...command.payload, feedback: '请更详细' },
    })).rejects.toMatchObject({
      message: '幂等键已用于不同的阅读准备操作',
      statusCode: 409,
    });

    expect(await store.current(graph.userBookId)).toMatchObject({
      operationId: initial.id,
      status: 'pending',
      canResume: true,
      recoverableInput: { feedback: '请更简洁' },
    });

    const claim = await store.claim(initial);
    expect(claim.attemptCount).toBe(1);
    expect(await store.renew(claim)).toBe(true);
    expect(await store.fail(claim, new UserBookError('模型暂时不可用', 503))).toBe(true);
    expect(await store.current(graph.userBookId)).toMatchObject({
      operationId: initial.id,
      operationAttempt: 1,
      status: 'failed',
      errorSummary: '模型暂时不可用',
      recoverableInput: { feedback: '请更简洁' },
    });
  });

  it('fences an expired claim after a new attempt takes ownership', async () => {
    const { db } = getTestDatabase();
    const graph = await strategyReviewGraph(db);
    const store = createStore();
    const operation = await store.resolve(graph.userBookId, {
      kind: 'strategy_revision',
      source: 'strategy_feedback',
      baseStrategyDraftVersionId: graph.strategyDraftVersionId,
      baseTrialRevisionId: null,
      idempotencyKey: 'strategy-feedback-fencing',
      payload: {
        source: 'strategy_feedback',
        strategyDraftVersionId: graph.strategyDraftVersionId,
        feedback: '调整说明',
      },
    });
    const firstClaim = await store.claim(operation);
    await db
      .update(readingSetupOperations)
      .set({
        leaseClaimedAt: sql`now() - interval '2 minutes'`,
        leaseExpiresAt: sql`now() - interval '1 minute'`,
      })
      .where(and(
        eq(readingSetupOperations.id, operation.id),
        eq(readingSetupOperations.leaseId, firstClaim.leaseId),
      ));
    const expired = await store.observeById(graph.userBookId, operation.id);
    expect(expired?.leaseExpired).toBe(true);

    const secondClaim = await store.claim(expired!.operation);
    expect(secondClaim.attemptCount).toBe(2);
    expect(secondClaim.leaseId).not.toBe(firstClaim.leaseId);
    expect(await store.fail(firstClaim, new Error('stale failure'))).toBe(false);
    expect(await store.renew(firstClaim)).toBe(false);
    expect(await store.fail(secondClaim, new Error('current failure'))).toBe(true);
  });
});
