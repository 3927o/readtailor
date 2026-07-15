import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
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
} from '../../test/database';

const describePostgres = hasTestDatabase ? describe : describe.skip;
const skipReason = hasTestDatabase ? '' : ' (skipped: TEST_DATABASE_URL is not set)';

const contents = ['第一节点正文abcdefghij', '第二节点正文abcdefghij', '第三节点正文abcdefghij'];
const manifest = {
  nodes: contents.map((content, index) => ({
    section_id: `section-${index + 1}`,
    segment: 1,
    order: index + 1,
    title: `第 ${index + 1} 节`,
    parent_section_id: null,
    tailoring_eligible: true,
    blocks: [{ block_index: 1, block_utf16_length: content.length }],
  })),
  outline: contents.map((_content, index) => ({
    section_id: `section-${index + 1}`,
    title: `第 ${index + 1} 节`,
    parent_section_id: null,
  })),
};
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
        section_id: node.section_id,
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
});
