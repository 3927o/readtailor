import { and, asc, eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import {
  nodeGenerations,
  sharedBooks,
  strategyDraftVersions,
  strategyVersions,
  trialRevisions,
  userBooks,
} from '@readtailor/database';
import {
  getTestDatabase,
  hasTestDatabase,
  trialReviewGraph,
} from '../../test/database';
import { createReadingManifestFixture } from '../../test/reading-manifest';
import { createStrategyAdoptionService } from './adoption-service';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

const orderedManifest = createReadingManifestFixture([1, 2, 3, 4, 5].map((order) => ({
  sectionId: `formal-${order}`,
  text: `正文 ${order}`,
})));
const unorderedManifest = {
  ...orderedManifest,
  nodes: [5, 2, 4, 1, 3].map((order) => orderedManifest.nodes[order - 1]!),
};

describePostgres(`strategy adoption service${skipReason}`, () => {
  it('creates the initial formal window in manifest reading order', async () => {
    const { db } = getTestDatabase();
    const graph = await trialReviewGraph(db);
    const ensureFormalWindow = vi.fn(async () => {});
    const enqueuePendingFormalGenerations = vi.fn(async () => {});
    const service = createStrategyAdoptionService({
      db,
      userId: graph.userId,
      modelConfigId: 'adoption-service-test-model',
      formalWindowSize: 4,
      getOwnedBook: async (userBookId) => {
        const [owned] = await db
          .select({ userBook: userBooks, sharedBook: sharedBooks })
          .from(userBooks)
          .innerJoin(sharedBooks, eq(sharedBooks.id, userBooks.sharedBookId))
          .where(and(eq(userBooks.id, userBookId), eq(userBooks.userId, graph.userId)))
          .limit(1);
        return owned!;
      },
      loadManifest: async () => unorderedManifest,
      ensureFormalWindow,
      enqueuePendingFormalGenerations,
    });

    const result = await service.confirmStrategyAndStartReading(graph.userBookId, {
      trialRevisionId: graph.trialRevisionId,
      strategyDraftVersionId: graph.strategyDraftVersionId,
    });

    const [strategy] = await db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.userBookId, graph.userBookId));
    const generations = await db
      .select()
      .from(nodeGenerations)
      .where(and(
        eq(nodeGenerations.userBookId, graph.userBookId),
        eq(nodeGenerations.generationScope, 'formal'),
      ))
      .orderBy(asc(nodeGenerations.sectionId));

    expect(result).toEqual({
      userBookId: graph.userBookId,
      workflowStatus: 'active_reading',
      strategyVersionId: strategy!.id,
    });
    expect(generations.map(({ sectionId }) => sectionId)).toEqual([
      'formal-1',
      'formal-2',
      'formal-3',
      'formal-4',
    ]);
    expect(generations.every(({ strategyVersionId }) => strategyVersionId === strategy!.id)).toBe(true);
    expect(ensureFormalWindow).toHaveBeenCalledOnce();
    expect(ensureFormalWindow).toHaveBeenCalledWith(
      graph.userBookId,
      strategy!.id,
      graph.sharedBookId,
      1,
    );
    expect(enqueuePendingFormalGenerations).not.toHaveBeenCalled();
  });

  it('rejects a stale current trial pointer without creating formal state', async () => {
    const { db } = getTestDatabase();
    const graph = await trialReviewGraph(db);
    const ensureFormalWindow = vi.fn(async () => {});
    const enqueuePendingFormalGenerations = vi.fn(async () => {});
    const service = createStrategyAdoptionService({
      db,
      userId: graph.userId,
      modelConfigId: 'adoption-service-test-model',
      formalWindowSize: 4,
      getOwnedBook: async (userBookId) => {
        const [owned] = await db
          .select({ userBook: userBooks, sharedBook: sharedBooks })
          .from(userBooks)
          .innerJoin(sharedBooks, eq(sharedBooks.id, userBooks.sharedBookId))
          .where(and(eq(userBooks.id, userBookId), eq(userBooks.userId, graph.userId)))
          .limit(1);
        return owned!;
      },
      loadManifest: async () => {
        await db
          .update(userBooks)
          .set({ workflowStatus: 'strategy_review', currentTrialRevisionId: null })
          .where(eq(userBooks.id, graph.userBookId));
        return unorderedManifest;
      },
      ensureFormalWindow,
      enqueuePendingFormalGenerations,
    });

    await expect(service.confirmStrategyAndStartReading(graph.userBookId, {
      trialRevisionId: graph.trialRevisionId,
      strategyDraftVersionId: graph.strategyDraftVersionId,
    })).rejects.toMatchObject({ statusCode: 409 });

    const strategies = await db
      .select()
      .from(strategyVersions)
      .where(eq(strategyVersions.userBookId, graph.userBookId));
    const formalGenerations = await db
      .select()
      .from(nodeGenerations)
      .where(and(
        eq(nodeGenerations.userBookId, graph.userBookId),
        eq(nodeGenerations.generationScope, 'formal'),
      ));
    const [draft] = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.id, graph.strategyDraftVersionId));
    const [revision] = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.id, graph.trialRevisionId));

    expect(strategies).toHaveLength(0);
    expect(formalGenerations).toHaveLength(0);
    expect(draft).toMatchObject({ status: 'approved_for_trial', confirmedAt: null });
    expect(revision).toMatchObject({ status: 'published', adoptedAt: null });
    expect(ensureFormalWindow).not.toHaveBeenCalled();
    expect(enqueuePendingFormalGenerations).not.toHaveBeenCalled();
  });
});
