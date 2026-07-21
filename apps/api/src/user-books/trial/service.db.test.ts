import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { TrialFragmentSelection } from '@readtailor/agent-kit';
import {
  nodeGenerations,
  readingSetupOperations,
  strategyDraftVersions,
  trialRevisions,
  trialSegments,
  userBooks,
} from '@readtailor/database';
import type { AskAiEngine } from '../../ask-ai-engine';
import type { BookService } from '../../books';
import type { ReadingSetupEngine } from '../../reading-setup-engine';
import { createUserBookService, type ContentGenerationEnqueuer } from '../../user-books';
import {
  getTestDatabase,
  hasTestDatabase,
  strategyReviewGraph,
  trialGenerationFailedGraph,
  trialReviewGraph,
} from '../../test/database';
import { createReadingManifestFixture } from '../../test/reading-manifest';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

const contents = ['第一节点正文abcdefghij', '第二节点正文abcdefghij', '第三节点正文abcdefghij'];
const manifest = createReadingManifestFixture(contents.map((text, index) => ({
  sectionId: `section-${index + 1}`,
  text,
  title: `第 ${index + 1} 节`,
})));
const html = `<!doctype html><html><body><main id="book" data-type="book">${contents
  .map((content, index) => `<section id="section-${index + 1}" data-type="section"><p>${content}</p></section>`)
  .join('')}</main></body></html>`;
const books: BookService = {
  async listBooks() { return []; },
  async canAccess() { return true; },
  async getNormalizationStatus() { return null; },
  async getBook() { return null; },
  async getManifest() { return manifest; },
  async getProfile() {
    return {
      trial_candidates: manifest.nodes.map((node) => ({
        section_id: node.sectionId,
        segment: node.segment,
      })),
    };
  },
  async getContent() { return new TextEncoder().encode(html); },
  async getAsset() { return null; },
};
const askAiEngine: AskAiEngine = {
  async runTurn() { throw new Error('not used'); },
};
const unusedSetupEngine: ReadingSetupEngine = {
  async runTurn() { throw new Error('not used'); },
};

type TrialNodeContent = {
  section_id: string;
  segment: number;
  blocks: Array<{ block_index: number; text: string }>;
};

function fragments(input: Parameters<ReadingSetupEngine['runTurn']>[0]): TrialFragmentSelection[] {
  const nodes = input.context.trialNodeContents as TrialNodeContent[];
  const tags = ['threshold', 'typical', 'hardest'] as const;
  return nodes.map((node, index) => ({
    section_id: node.section_id,
    segment: node.segment,
    tag: tags[index]!,
    range: {
      start: { block_index: node.blocks[0]!.block_index },
      end: { block_index: node.blocks.at(-1)!.block_index },
    },
    reason: `验证 ${tags[index]}`,
  }));
}

function createService(
  setupEngine: ReadingSetupEngine,
  generations: ContentGenerationEnqueuer,
) {
  return createUserBookService({
    db: getTestDatabase().db,
    books,
    setupEngine,
    askAiEngine,
    generations,
    modelConfigId: 'trial-service-test-model',
  });
}

async function collect<T>(stream: AsyncGenerator<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describePostgres(`trial service${skipReason}`, () => {
  it('rolls back approval when the operation claim is replaced before finalization', async () => {
    const { db } = getTestDatabase();
    const graph = await strategyReviewGraph(db);
    const replacementLeaseId = randomUUID();
    const setupEngine: ReadingSetupEngine = {
      async runTurn(input) {
        const [operation] = await db
          .select()
          .from(readingSetupOperations)
          .where(eq(readingSetupOperations.userBookId, graph.userBookId));
        await db
          .update(readingSetupOperations)
          .set({ leaseId: replacementLeaseId })
          .where(eq(readingSetupOperations.id, operation!.id));
        return { type: 'fragments', fragments: fragments(input) };
      },
    };
    const service = createService(setupEngine, { async enqueue() {} }).forUser(graph.userId);
    const events = await collect(service.streamApproveStrategy(graph.userBookId, {
      strategyDraftVersionId: graph.strategyDraftVersionId,
      idempotencyKey: randomUUID(),
    }));
    const revisions = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.userBookId, graph.userBookId));
    const segments = await db.select().from(trialSegments);
    const generations = await db
      .select()
      .from(nodeGenerations)
      .where(eq(nodeGenerations.userBookId, graph.userBookId));
    const [draft] = await db
      .select()
      .from(strategyDraftVersions)
      .where(eq(strategyDraftVersions.id, graph.strategyDraftVersionId));
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));

    expect(events.at(-1)).toMatchObject({ type: 'error', code: 'lease_lost' });
    expect(revisions).toHaveLength(0);
    expect(segments).toHaveLength(0);
    expect(generations).toHaveLength(0);
    expect(draft).toMatchObject({ status: 'draft', approvedForTrialAt: null });
    expect(book).toMatchObject({ workflowStatus: 'strategy_review', currentTrialRevisionId: null });
  });

  it('compensates a committed approval when generation enqueue fails', async () => {
    const { db } = getTestDatabase();
    const graph = await strategyReviewGraph(db);
    const setupEngine: ReadingSetupEngine = {
      async runTurn(input) {
        return { type: 'fragments', fragments: fragments(input) };
      },
    };
    const service = createService(setupEngine, {
      async enqueue() { throw new Error('queue unavailable'); },
    }).forUser(graph.userId);
    await collect(service.streamApproveStrategy(graph.userBookId, {
      strategyDraftVersionId: graph.strategyDraftVersionId,
      idempotencyKey: randomUUID(),
    }));
    const [revision] = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.userBookId, graph.userBookId));
    const segments = await db
      .select()
      .from(trialSegments)
      .where(eq(trialSegments.trialRevisionId, revision!.id));
    const generations = await db
      .select()
      .from(nodeGenerations)
      .where(eq(nodeGenerations.userBookId, graph.userBookId));
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));

    expect(revision).toMatchObject({ status: 'failed' });
    expect(segments).toHaveLength(3);
    expect(segments.every((segment) => segment.status === 'failed')).toBe(true);
    expect(generations).toHaveLength(3);
    expect(generations.every((generation) => generation.status === 'failed')).toBe(true);
    expect(book).toMatchObject({
      workflowStatus: 'trial_generation_failed',
      currentTrialRevisionId: revision!.id,
    });
  });

  it('retries a failed trial by superseding history and copying the exact three segments', async () => {
    const { db } = getTestDatabase();
    const graph = await trialGenerationFailedGraph(db);
    const oldSegments = await db
      .select()
      .from(trialSegments)
      .where(eq(trialSegments.trialRevisionId, graph.trialRevisionId))
      .orderBy(asc(trialSegments.ordinal));
    const enqueuedGenerationIds: string[] = [];
    const service = createService(unusedSetupEngine, {
      async enqueue(input) { enqueuedGenerationIds.push(input.generationId); },
    }).forUser(graph.userId);

    const snapshot = await service.retryTrial(graph.userBookId);

    const revisions = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.userBookId, graph.userBookId))
      .orderBy(asc(trialRevisions.revision));
    const allSegments = await db.select().from(trialSegments);
    const newSegments = allSegments
      .filter((segment) => segment.trialRevisionId === snapshot.trialRevisionId)
      .sort((left, right) => left.ordinal - right.ordinal);
    const generations = await db
      .select()
      .from(nodeGenerations)
      .where(eq(nodeGenerations.userBookId, graph.userBookId));
    const oldGenerationIds = new Set(graph.nodeGenerationIds);
    const oldGenerations = generations.filter((generation) => oldGenerationIds.has(generation.id));
    const newGenerations = generations.filter((generation) => !oldGenerationIds.has(generation.id));
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));

    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      id: graph.trialRevisionId,
      status: 'superseded',
    });
    expect(revisions[0]?.supersededAt).toBeInstanceOf(Date);
    expect(revisions[1]).toMatchObject({
      id: snapshot.trialRevisionId,
      revision: 2,
      status: 'generating',
      strategyDraftVersionId: graph.strategyDraftVersionId,
    });
    expect(oldGenerations).toHaveLength(3);
    expect(oldGenerations.every((generation) => (
      generation.status === 'superseded'
      && generation.result === null
      && generation.completedAt instanceof Date
    ))).toBe(true);
    expect(newSegments).toHaveLength(3);
    expect(newSegments.map(({ ordinal }) => ordinal)).toEqual([1, 2, 3]);
    expect(newSegments.map((segment) => ({
      ordinal: segment.ordinal,
      sectionId: segment.sectionId,
      segment: segment.segment,
      range: [
        segment.startBlockIndex,
        segment.startOffset,
        segment.endBlockIndex,
        segment.endOffset,
      ],
    }))).toEqual(oldSegments.map((segment) => ({
      ordinal: segment.ordinal,
      sectionId: segment.sectionId,
      segment: segment.segment,
      range: [
        segment.startBlockIndex,
        segment.startOffset,
        segment.endBlockIndex,
        segment.endOffset,
      ],
    })));
    expect(newSegments.every((segment) => segment.status === 'pending')).toBe(true);
    expect(newGenerations).toHaveLength(3);
    expect(newGenerations.every((generation) => generation.status === 'queued')).toBe(true);
    expect(new Set(enqueuedGenerationIds)).toEqual(
      new Set(newGenerations.map(({ id }) => id)),
    );
    expect(book).toMatchObject({
      workflowStatus: 'trial_generating',
      currentStrategyDraftVersionId: graph.strategyDraftVersionId,
      currentTrialRevisionId: snapshot.trialRevisionId,
    });
    expect(snapshot).toMatchObject({
      workflowStatus: 'trial_generating',
      status: 'generating',
      canAdopt: false,
    });
  });

  it('compensates a retried revision when generation enqueue fails', async () => {
    const { db } = getTestDatabase();
    const graph = await trialGenerationFailedGraph(db);
    const service = createService(unusedSetupEngine, {
      async enqueue() { throw new Error('queue unavailable'); },
    }).forUser(graph.userId);

    const snapshot = await service.retryTrial(graph.userBookId);

    const revisions = await db
      .select()
      .from(trialRevisions)
      .where(eq(trialRevisions.userBookId, graph.userBookId))
      .orderBy(asc(trialRevisions.revision));
    const generations = await db
      .select()
      .from(nodeGenerations)
      .where(eq(nodeGenerations.userBookId, graph.userBookId));
    const newGenerations = generations.filter((generation) => (
      !graph.nodeGenerationIds.includes(generation.id)
    ));
    const newSegments = await db
      .select()
      .from(trialSegments)
      .where(eq(trialSegments.trialRevisionId, snapshot.trialRevisionId));
    const [book] = await db.select().from(userBooks).where(eq(userBooks.id, graph.userBookId));

    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.status).toBe('superseded');
    expect(revisions[1]).toMatchObject({
      id: snapshot.trialRevisionId,
      status: 'failed',
    });
    expect(revisions[1]?.failedAt).toBeInstanceOf(Date);
    expect(newSegments).toHaveLength(3);
    expect(newSegments.every((segment) => segment.status === 'failed')).toBe(true);
    expect(newGenerations).toHaveLength(3);
    expect(newGenerations.every((generation) => (
      generation.status === 'failed'
      && generation.errorSummary === '内容生成任务入队失败'
      && generation.completedAt instanceof Date
    ))).toBe(true);
    expect(book).toMatchObject({
      workflowStatus: 'trial_generation_failed',
      currentTrialRevisionId: snapshot.trialRevisionId,
    });
    expect(snapshot).toMatchObject({
      workflowStatus: 'trial_generation_failed',
      status: 'failed',
      canAdopt: false,
    });
  });

  it('marks a current ready segment viewed repeatedly without changing adoption eligibility', async () => {
    const { db } = getTestDatabase();
    const graph = await trialReviewGraph(db);
    const service = createService(unusedSetupEngine, { async enqueue() {} }).forUser(graph.userId);
    const input = {
      trialRevisionId: graph.trialRevisionId,
      trialSegmentId: graph.trialSegmentIds[0]!,
    };

    const first = await service.markTrialViewed(graph.userBookId, input);
    const second = await service.markTrialViewed(graph.userBookId, input);
    const [segment] = await db
      .select()
      .from(trialSegments)
      .where(eq(trialSegments.id, input.trialSegmentId));

    expect(segment?.viewedAt).toBeInstanceOf(Date);
    expect(first.canAdopt).toBe(true);
    expect(second.canAdopt).toBe(true);
    expect(second.segments[0]?.viewedAt).not.toBeNull();
  });

  it('rejects viewing a segment through a non-current revision', async () => {
    const { db } = getTestDatabase();
    const graph = await trialReviewGraph(db);
    const now = new Date();
    const [otherRevision] = await db
      .insert(trialRevisions)
      .values({
        userBookId: graph.userBookId,
        strategyDraftVersionId: graph.strategyDraftVersionId,
        revision: 2,
        status: 'adopted',
        publishedAt: now,
        adoptedAt: now,
      })
      .returning({ id: trialRevisions.id });
    await db
      .update(userBooks)
      .set({ currentTrialRevisionId: otherRevision!.id })
      .where(eq(userBooks.id, graph.userBookId));
    const service = createService(unusedSetupEngine, { async enqueue() {} }).forUser(graph.userId);

    await expect(service.markTrialViewed(graph.userBookId, {
      trialRevisionId: graph.trialRevisionId,
      trialSegmentId: graph.trialSegmentIds[0]!,
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects viewing a segment that is not ready', async () => {
    const { db } = getTestDatabase();
    const graph = await trialReviewGraph(db);
    await db
      .update(trialSegments)
      .set({ status: 'generating' })
      .where(eq(trialSegments.id, graph.trialSegmentIds[0]!));
    const service = createService(unusedSetupEngine, { async enqueue() {} }).forUser(graph.userId);

    await expect(service.markTrialViewed(graph.userBookId, {
      trialRevisionId: graph.trialRevisionId,
      trialSegmentId: graph.trialSegmentIds[0]!,
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});
