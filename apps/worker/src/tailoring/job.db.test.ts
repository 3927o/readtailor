import { asc, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  nodeGenerations,
  trialRevisions,
  trialSegments,
  userBooks,
  type Database,
} from '@readtailor/database';
import {
  getTestDatabase,
  hasTestDatabase,
  trialGeneratingGraph,
} from '../../../api/src/test/database';
import { failContentGeneration, finalizeContentGeneration } from './job';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';
const result = {
  guide: '数据库测试导读',
  annotations: [],
  afterReading: '数据库测试回顾',
};

async function loadFinalizeInput(db: Database, generationId: string) {
  const [generation] = await db
    .select()
    .from(nodeGenerations)
    .where(eq(nodeGenerations.id, generationId));
  if (!generation?.trialSegmentId) throw new Error('trial generation fixture is incomplete');
  const [trialSegment] = await db
    .select()
    .from(trialSegments)
    .where(eq(trialSegments.id, generation.trialSegmentId));
  if (!trialSegment) throw new Error('trial segment fixture is incomplete');
  return { generation, trialSegment };
}

describePostgres(`trial generation finalizers PostgreSQL integration${skipReason}`, () => {
  it('fences an attempt 1 finalizer after the generation advances to attempt 2', async () => {
    const { db } = getTestDatabase();
    const graph = await trialGeneratingGraph(db);
    const staleInput = await loadFinalizeInput(db, graph.nodeGenerationIds[0]!);
    await db
      .update(nodeGenerations)
      .set({ attemptCount: 2, startedAt: new Date(), updatedAt: new Date() })
      .where(eq(nodeGenerations.id, staleInput.generation.id));

    await finalizeContentGeneration({
      db,
      ...staleInput,
      claimedAttempt: 1,
      result,
    });

    const [generation] = await db
      .select()
      .from(nodeGenerations)
      .where(eq(nodeGenerations.id, staleInput.generation.id));
    const [segment] = await db
      .select()
      .from(trialSegments)
      .where(eq(trialSegments.id, staleInput.trialSegment.id));
    const [revision] = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.id, graph.trialRevisionId));
    const [book] = await db
      .select()
      .from(userBooks)
      .where(eq(userBooks.id, graph.userBookId));

    expect(generation).toMatchObject({
      status: 'generating',
      attemptCount: 2,
      result: null,
      completedAt: null,
    });
    expect(segment?.status).toBe('generating');
    expect(revision).toMatchObject({ status: 'generating', publishedAt: null });
    expect(book?.workflowStatus).toBe('trial_generating');
  });

  it('publishes only after 3/3 ready and publishes once under concurrent finalization', async () => {
    const { db } = getTestDatabase();
    const graph = await trialGeneratingGraph(db);

    for (const generationId of graph.nodeGenerationIds.slice(0, 2)) {
      const input = await loadFinalizeInput(db, generationId);
      await finalizeContentGeneration({
        db,
        ...input,
        claimedAttempt: 1,
        result,
      });
    }

    const segmentsBeforePublish = await db
      .select({ ordinal: trialSegments.ordinal, status: trialSegments.status })
      .from(trialSegments)
      .where(eq(trialSegments.trialRevisionId, graph.trialRevisionId))
      .orderBy(asc(trialSegments.ordinal));
    const [revisionBeforePublish] = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.id, graph.trialRevisionId));
    const [bookBeforePublish] = await db
      .select()
      .from(userBooks)
      .where(eq(userBooks.id, graph.userBookId));

    expect(segmentsBeforePublish.map(({ status }) => status)).toEqual([
      'ready',
      'ready',
      'generating',
    ]);
    expect(revisionBeforePublish).toMatchObject({
      status: 'generating',
      publishedAt: null,
    });
    expect(bookBeforePublish?.workflowStatus).toBe('trial_generating');

    const finalInput = await loadFinalizeInput(db, graph.nodeGenerationIds[2]!);
    await Promise.all([
      finalizeContentGeneration({
        db,
        ...finalInput,
        claimedAttempt: 1,
        result,
      }),
      finalizeContentGeneration({
        db,
        ...finalInput,
        claimedAttempt: 1,
        result,
      }),
    ]);

    const [publishedRevision] = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.id, graph.trialRevisionId));
    const [publishedBook] = await db
      .select()
      .from(userBooks)
      .where(eq(userBooks.id, graph.userBookId));
    const publishedSegments = await db
      .select({ status: trialSegments.status })
      .from(trialSegments)
      .where(eq(trialSegments.trialRevisionId, graph.trialRevisionId));
    const publishedGenerations = await db
      .select({ status: nodeGenerations.status })
      .from(nodeGenerations)
      .where(inArray(nodeGenerations.id, graph.nodeGenerationIds));

    expect(publishedRevision?.status).toBe('published');
    expect(publishedRevision?.publishedAt).toBeInstanceOf(Date);
    expect(publishedBook?.workflowStatus).toBe('trial_review');
    expect(publishedSegments.map(({ status }) => status)).toEqual([
      'ready',
      'ready',
      'ready',
    ]);
    expect(publishedGenerations.map(({ status }) => status)).toEqual([
      'ready',
      'ready',
      'ready',
    ]);

    const publishedAt = publishedRevision?.publishedAt;
    await finalizeContentGeneration({
      db,
      ...finalInput,
      claimedAttempt: 1,
      result,
    });
    const [replayedRevision] = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.id, graph.trialRevisionId));
    expect(replayedRevision?.publishedAt).toEqual(publishedAt);
  });

  it('fails unfinished siblings and preserves an already ready result', async () => {
    const { db } = getTestDatabase();
    const graph = await trialGeneratingGraph(db);
    const readyInput = await loadFinalizeInput(db, graph.nodeGenerationIds[0]!);
    await finalizeContentGeneration({
      db,
      ...readyInput,
      claimedAttempt: 1,
      result,
    });

    const [readyBeforeFailure] = await db
      .select()
      .from(nodeGenerations)
      .where(eq(nodeGenerations.id, graph.nodeGenerationIds[0]!));
    await failContentGeneration({
      db,
      generationId: graph.nodeGenerationIds[1]!,
      error: new Error('terminal model failure'),
    });

    const [failedRevision] = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.id, graph.trialRevisionId));
    const [failedBook] = await db
      .select()
      .from(userBooks)
      .where(eq(userBooks.id, graph.userBookId));
    const failedSegments = await db
      .select({ ordinal: trialSegments.ordinal, status: trialSegments.status })
      .from(trialSegments)
      .where(eq(trialSegments.trialRevisionId, graph.trialRevisionId))
      .orderBy(asc(trialSegments.ordinal));
    const generationRows = await db
      .select()
      .from(nodeGenerations)
      .where(inArray(nodeGenerations.id, graph.nodeGenerationIds));
    const generationById = new Map(generationRows.map((generation) => [generation.id, generation]));
    const readyAfterFailure = generationById.get(graph.nodeGenerationIds[0]!);

    expect(failedRevision?.status).toBe('failed');
    expect(failedRevision?.failedAt).toBeInstanceOf(Date);
    expect(failedRevision?.failureSummary).toBeTruthy();
    expect(failedBook?.workflowStatus).toBe('trial_generation_failed');
    expect(failedSegments.map(({ status }) => status)).toEqual([
      'ready',
      'failed',
      'failed',
    ]);
    expect(graph.nodeGenerationIds.map((id) => generationById.get(id)?.status)).toEqual([
      'ready',
      'failed',
      'failed',
    ]);
    expect(readyAfterFailure?.result).toEqual(readyBeforeFailure?.result);
    expect(readyAfterFailure?.completedAt).toEqual(readyBeforeFailure?.completedAt);
    expect(generationById.get(graph.nodeGenerationIds[1]!)?.errorSummary)
      .toBe('terminal model failure');
  });
});
