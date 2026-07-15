import { and, eq, inArray } from 'drizzle-orm';
import type { JsonValue, TailoringGenerationInput, TailoringModelClient } from '@readtailor/tailoring';
import {
  createTailoringCacheKey,
  extractNodeSourceFromHtml,
  generateTailoredContent,
  sliceNodeSource,
} from '@readtailor/tailoring';
import {
  bookPackages,
  bookReaderProfileVersions,
  nodeGenerations,
  readerProfiles,
  readerProfileVersions,
  readerReadNodes,
  readerStates,
  sharedBooks,
  strategyDraftVersions,
  strategyVersions,
  trialRevisions,
  trialSegments,
  userBooks,
  type Database,
} from '@readtailor/database';
import type { ModelEngine } from '@readtailor/model';
import type { PerfSink } from '@readtailor/observability';
import type { ObjectStorage } from '@readtailor/storage';

type ManifestNode = {
  section_id: string;
  segment: number;
  order: number;
  title?: string;
  parent_section_id?: string | null;
  tailoring_eligible: boolean;
};

type ManifestOutline = {
  section_id: string;
  title: string;
  parent_section_id: string | null;
};

type Manifest = { nodes: ManifestNode[]; outline: ManifestOutline[] };

function jsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function ancestorTitles(node: ManifestNode, outline: ManifestOutline[]): string[] {
  const byId = new Map(outline.map((item) => [item.section_id, item]));
  const titles: string[] = [];
  let parent = node.parent_section_id ? byId.get(node.parent_section_id) : undefined;
  while (parent) {
    if (parent.title.trim()) titles.unshift(parent.title.trim());
    parent = parent.parent_section_id ? byId.get(parent.parent_section_id) : undefined;
  }
  return titles;
}

function contextExcerpt(rawHtml: string, node: ManifestNode | undefined, edge: 'start' | 'end'): string | null {
  if (!node) return null;
  const source = extractNodeSourceFromHtml(rawHtml, node.section_id, node.segment);
  const text = source.blocks.map((block) => block.text).join('\n').trim();
  if (!text) return null;
  return edge === 'start' ? text.slice(0, 1200) : text.slice(-1200);
}

function createModelClient(
  engine: ModelEngine,
  telemetry?: { perfSink?: PerfSink; requestId: string },
): TailoringModelClient {
  return {
    async generate(request) {
      if (engine.name === 'fake') {
        return JSON.stringify({
          guide: '先留意这一段正在推进的问题，以及关键概念之间的关系。',
          annotations: [],
          after_reading: '读完后，可以用一句话复述这一段在全书主线中的作用。',
        });
      }
      const started = performance.now();
      let content = '';
      try {
        for await (const event of engine.streamChat(request.prompt, { maxTokens: 4096 })) {
          if (event.type === 'content') content += event.text;
        }
        telemetry?.perfSink?.recordAgentCall({
          requestId: telemetry.requestId,
          source: 'worker',
          kind: 'content_generation',
          model: engine.name,
          status: 'ok',
          durationMs: performance.now() - started,
          promptChars: request.prompt.length,
          outputChars: content.length,
        });
      } catch (error) {
        telemetry?.perfSink?.recordAgentCall({
          requestId: telemetry.requestId,
          source: 'worker',
          kind: 'content_generation',
          model: engine.name,
          status: 'error',
          durationMs: performance.now() - started,
          promptChars: request.prompt.length,
          outputChars: content.length,
          errorSummary: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        });
        throw error;
      }
      return content;
    },
  };
}

type FormalGeneration = {
  id: string;
  userBookId: string;
  strategyVersionId: string | null;
  sectionId: string;
  segment: number;
};

type TrialGenerationIdentity = {
  id: string;
  userBookId: string;
  generationScope: string;
  trialSegmentId: string | null;
  strategyDraftVersionId: string | null;
  sectionId: string;
  segment: number;
};

type TrialSegmentHint = {
  id: string;
  trialRevisionId: string;
};

export type TrialGenerationGraphCheck = {
  generation: {
    userBookId: string;
    generationScope: string;
    trialSegmentId: string | null;
    strategyDraftVersionId: string | null;
    sectionId: string;
    segment: number;
  };
  segment: {
    id: string;
    trialRevisionId: string;
    sectionId: string;
    segment: number;
  };
  revision: {
    id: string;
    userBookId: string;
    strategyDraftVersionId: string;
    status: string;
  };
  draft: {
    id: string;
    status: string;
  };
  userBook: {
    id: string;
    workflowStatus: string;
    currentStrategyDraftVersionId: string | null;
    currentTrialRevisionId: string | null;
  };
};

export function isCurrentTrialGenerationGraph(graph: TrialGenerationGraphCheck): boolean {
  return graph.generation.generationScope === 'trial'
    && graph.generation.userBookId === graph.userBook.id
    && graph.generation.trialSegmentId === graph.segment.id
    && graph.generation.strategyDraftVersionId === graph.draft.id
    && graph.generation.strategyDraftVersionId === graph.revision.strategyDraftVersionId
    && graph.generation.sectionId === graph.segment.sectionId
    && graph.generation.segment === graph.segment.segment
    && graph.segment.trialRevisionId === graph.revision.id
    && graph.revision.userBookId === graph.userBook.id
    && graph.revision.status === 'generating'
    && graph.draft.status === 'approved_for_trial'
    && graph.userBook.workflowStatus === 'trial_generating'
    && graph.userBook.currentStrategyDraftVersionId === graph.draft.id
    && graph.userBook.currentTrialRevisionId === graph.revision.id;
}

export function nextGenerationAttempt(attemptCount: number, maxAttempts: number): number | null {
  return attemptCount >= maxAttempts ? null : attemptCount + 1;
}

export function shouldPublishTrialRevision(
  segments: Array<{ ordinal: number; status: string }>,
): boolean {
  return segments.length === 3
    && new Set(segments.map((segment) => segment.ordinal)).size === 3
    && segments.every((segment) => segment.status === 'ready');
}

export function trialSegmentIdsToFail(
  segments: Array<{ id: string; status: string }>,
): string[] {
  return segments
    .filter((segment) => segment.status === 'pending' || segment.status === 'generating')
    .map((segment) => segment.id);
}

type LockedTrialGenerationGraph = {
  generation: typeof nodeGenerations.$inferSelect | undefined;
  segment: typeof trialSegments.$inferSelect | undefined;
  revision: typeof trialRevisions.$inferSelect | undefined;
  draft: typeof strategyDraftVersions.$inferSelect | undefined;
  userBook: typeof userBooks.$inferSelect | undefined;
};

async function lockTrialGenerationGraph(
  db: Pick<Database, 'select'>,
  identity: TrialGenerationIdentity,
  segmentHint: TrialSegmentHint,
): Promise<LockedTrialGenerationGraph> {
  // Every trial writer uses this lock order so completion, terminal failure and retry can fence
  // each other without publishing or mutating an obsolete revision.
  const userBook = await db
    .select()
    .from(userBooks)
    .where(eq(userBooks.id, identity.userBookId))
    .limit(1)
    .for('update')
    .then((rows) => rows[0]);
  const revision = await db
    .select()
    .from(trialRevisions)
    .where(eq(trialRevisions.id, segmentHint.trialRevisionId))
    .limit(1)
    .for('update')
    .then((rows) => rows[0]);
  const draft = identity.strategyDraftVersionId
    ? await db
        .select()
        .from(strategyDraftVersions)
        .where(eq(strategyDraftVersions.id, identity.strategyDraftVersionId))
        .limit(1)
        .for('update')
        .then((rows) => rows[0])
    : undefined;
  const segment = await db
    .select()
    .from(trialSegments)
    .where(eq(trialSegments.id, segmentHint.id))
    .limit(1)
    .for('update')
    .then((rows) => rows[0]);
  const generation = await db
    .select()
    .from(nodeGenerations)
    .where(eq(nodeGenerations.id, identity.id))
    .limit(1)
    .for('update')
    .then((rows) => rows[0]);
  return { generation, segment, revision, draft, userBook };
}

function graphIsCurrent(graph: LockedTrialGenerationGraph): graph is {
  generation: typeof nodeGenerations.$inferSelect;
  segment: typeof trialSegments.$inferSelect;
  revision: typeof trialRevisions.$inferSelect;
  draft: typeof strategyDraftVersions.$inferSelect;
  userBook: typeof userBooks.$inferSelect;
} {
  return Boolean(
    graph.generation
    && graph.segment
    && graph.revision
    && graph.draft
    && graph.userBook
    && isCurrentTrialGenerationGraph({
      generation: graph.generation,
      segment: graph.segment,
      revision: graph.revision,
      draft: graph.draft,
      userBook: graph.userBook,
    }),
  );
}

async function supersedeStaleTrialGeneration(
  db: Pick<Database, 'update'>,
  generationId: string,
  expectedAttemptCount?: number,
): Promise<void> {
  const now = new Date();
  await db
    .update(nodeGenerations)
    .set({
      status: 'superseded',
      result: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(nodeGenerations.id, generationId),
      inArray(nodeGenerations.status, ['queued', 'retrying', 'generating']),
      expectedAttemptCount === undefined
        ? undefined
        : eq(nodeGenerations.attemptCount, expectedAttemptCount),
    ));
}

const GENERATION_ATTEMPT_FIELD = 'readtailorGenerationAttempt';

function errorForGenerationAttempt(error: unknown, attemptCount: number): Error {
  const value = error instanceof Error ? error : new Error(String(error));
  Object.defineProperty(value, GENERATION_ATTEMPT_FIELD, {
    configurable: true,
    enumerable: true,
    value: attemptCount,
  });
  return value;
}

function generationAttemptFromError(error: Error): number | undefined {
  const value = (error as unknown as Record<string, unknown>)[GENERATION_ATTEMPT_FIELD];
  return Number.isInteger(value) && (value as number) > 0 ? value as number : undefined;
}

export async function discardUnexpectedFormalGeneration(
  db: Pick<Database, 'select' | 'update'>,
  generation: FormalGeneration,
): Promise<boolean> {
  const book = await db
    .select({ strategyVersionId: userBooks.currentStrategyVersionId })
    .from(userBooks)
    .where(eq(userBooks.id, generation.userBookId))
    .limit(1)
    .for('share')
    .then((rows) => rows[0]);
  const state = await db
    .select({ sectionId: readerStates.sectionId, segment: readerStates.segment })
    .from(readerStates)
    .where(eq(readerStates.userBookId, generation.userBookId))
    .limit(1)
    .for('share')
    .then((rows) => rows[0]);
  const readNode = await db
    .select({ strategyVersionId: readerReadNodes.strategyVersionId })
    .from(readerReadNodes)
    .where(and(
      eq(readerReadNodes.userBookId, generation.userBookId),
      eq(readerReadNodes.sectionId, generation.sectionId),
      eq(readerReadNodes.segment, generation.segment),
    ))
    .limit(1)
    .for('share')
    .then((rows) => rows[0]);
  const isCurrentNode = state?.sectionId === generation.sectionId
    && state.segment === generation.segment;
  const expectedStrategyVersionId = isCurrentNode || !readNode
    ? book?.strategyVersionId ?? null
    : readNode.strategyVersionId;
  if (generation.strategyVersionId === expectedStrategyVersionId) return false;

  const now = new Date();
  const discarded = await db
    .update(nodeGenerations)
    .set({
      status: 'superseded',
      result: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(nodeGenerations.id, generation.id),
      inArray(nodeGenerations.status, ['queued', 'retrying', 'generating']),
    ))
    .returning({ id: nodeGenerations.id });
  return discarded.length > 0;
}

type ReadyGenerationResult = NonNullable<(typeof nodeGenerations.$inferSelect)['result']>;

export async function finalizeContentGeneration(options: {
  db: Database;
  generation: typeof nodeGenerations.$inferSelect;
  trialSegment?: typeof trialSegments.$inferSelect;
  claimedAttempt: number;
  result: ReadyGenerationResult;
}): Promise<void> {
  await options.db.transaction(async (tx) => {
    if (options.generation.generationScope === 'formal') {
      if (await discardUnexpectedFormalGeneration(tx, options.generation)) return;
      await tx
        .update(nodeGenerations)
        .set({
          status: 'ready',
          result: options.result,
          completedAt: new Date(),
          errorSummary: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(nodeGenerations.id, options.generation.id),
          eq(nodeGenerations.status, 'generating'),
          eq(nodeGenerations.attemptCount, options.claimedAttempt),
        ));
      return;
    }
    if (!options.trialSegment) return;
    const graph = await lockTrialGenerationGraph(tx, options.generation, {
      id: options.trialSegment.id,
      trialRevisionId: options.trialSegment.trialRevisionId,
    });
    if (!graphIsCurrent(graph)) {
      await supersedeStaleTrialGeneration(
        tx,
        options.generation.id,
        options.claimedAttempt,
      );
      return;
    }
    if (
      graph.generation.status !== 'generating'
      || graph.generation.attemptCount !== options.claimedAttempt
      || graph.segment.status !== 'generating'
    ) return;
    const [current] = await tx
      .update(nodeGenerations)
      .set({
        status: 'ready',
        result: options.result,
        completedAt: new Date(),
        errorSummary: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(nodeGenerations.id, graph.generation.id),
        eq(nodeGenerations.status, 'generating'),
        eq(nodeGenerations.attemptCount, options.claimedAttempt),
      ))
      .returning({ id: nodeGenerations.id });
    if (!current) return;
    const [changedSegment] = await tx
      .update(trialSegments)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(and(
        eq(trialSegments.id, graph.segment.id),
        eq(trialSegments.status, 'generating'),
      ))
      .returning({ id: trialSegments.id });
    if (!changedSegment) throw new Error('trial segment completion lost its generation claim');
    const siblings = await tx
      .select({ ordinal: trialSegments.ordinal, status: trialSegments.status })
      .from(trialSegments)
      .where(eq(trialSegments.trialRevisionId, graph.revision.id));
    if (!shouldPublishTrialRevision(siblings)) return;
    const [revision] = await tx
      .update(trialRevisions)
      .set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(trialRevisions.id, graph.revision.id),
        eq(trialRevisions.status, 'generating'),
      ))
      .returning({ id: trialRevisions.id });
    if (!revision) return;
    const [advanced] = await tx
      .update(userBooks)
      .set({ workflowStatus: 'trial_review', updatedAt: new Date() })
      .where(and(
        eq(userBooks.id, graph.userBook.id),
        eq(userBooks.currentStrategyDraftVersionId, graph.draft.id),
        eq(userBooks.currentTrialRevisionId, graph.revision.id),
        eq(userBooks.workflowStatus, 'trial_generating'),
      ))
      .returning({ id: userBooks.id });
    if (!advanced) throw new Error('trial revision published after its current pointer changed');
  });
}

export async function executeContentGeneration(options: {
  db: Database;
  storage: ObjectStorage;
  model: ModelEngine;
  generationId: string;
  perfSink?: PerfSink;
}) {
  const [row] = await options.db
    .select({
      generation: nodeGenerations,
      userBook: userBooks,
      sharedBook: sharedBooks,
      package: bookPackages,
    })
    .from(nodeGenerations)
    .innerJoin(userBooks, eq(userBooks.id, nodeGenerations.userBookId))
    .innerJoin(sharedBooks, eq(sharedBooks.id, userBooks.sharedBookId))
    .innerJoin(bookPackages, eq(bookPackages.id, sharedBooks.currentPackageId))
    .where(eq(nodeGenerations.id, options.generationId))
    .limit(1);
  if (!row) throw new Error('content generation does not exist');
  if (
    row.generation.status === 'ready'
    || row.generation.status === 'failed'
    || row.generation.status === 'superseded'
  ) return;
  if (
    row.generation.generationScope === 'formal'
    && await options.db.transaction((tx) => discardUnexpectedFormalGeneration(tx, row.generation))
  ) return;

  const [reader, bookReader, draft, formalStrategy, segment] = await Promise.all([
    options.db
      .select({ version: readerProfileVersions })
      .from(readerProfiles)
      .innerJoin(readerProfileVersions, eq(readerProfileVersions.id, readerProfiles.currentVersionId))
      .where(eq(readerProfiles.userId, row.userBook.userId))
      .limit(1)
      .then((rows) => rows[0]?.version),
    row.userBook.currentBookReaderProfileVersionId
      ? options.db
          .select()
          .from(bookReaderProfileVersions)
          .where(eq(bookReaderProfileVersions.id, row.userBook.currentBookReaderProfileVersionId))
          .limit(1)
          .then((rows) => rows[0])
      : Promise.resolve(undefined),
    row.generation.strategyDraftVersionId
      ? options.db.select().from(strategyDraftVersions).where(eq(strategyDraftVersions.id, row.generation.strategyDraftVersionId)).limit(1).then((rows) => rows[0])
      : Promise.resolve(undefined),
    row.generation.strategyVersionId
      ? options.db.select().from(strategyVersions).where(eq(strategyVersions.id, row.generation.strategyVersionId)).limit(1).then((rows) => rows[0])
      : Promise.resolve(undefined),
    row.generation.trialSegmentId
      ? options.db.select().from(trialSegments).where(eq(trialSegments.id, row.generation.trialSegmentId)).limit(1).then((rows) => rows[0])
      : Promise.resolve(undefined),
  ]);
  if (!reader || !bookReader) throw new Error('generation profiles are incomplete');

  const [htmlBytes, manifestBytes, bookProfileBytes] = await Promise.all([
    options.storage.get(`${row.package.objectPrefix}/book.normalized.html`),
    options.storage.get(`${row.package.objectPrefix}/reading_manifest.json`),
    options.storage.get(`${row.package.objectPrefix}/book_profile.json`),
  ]);
  const rawHtml = new TextDecoder().decode(htmlBytes);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  const bookProfile = JSON.parse(new TextDecoder().decode(bookProfileBytes)) as JsonValue;
  const node = manifest.nodes.find(
    (item) => item.section_id === row.generation.sectionId && item.segment === row.generation.segment,
  );
  if (!node) throw new Error('generation node is missing from manifest');
  const eligible = manifest.nodes.filter((item) => item.tailoring_eligible);
  const eligibleIndex = eligible.findIndex(
    (item) => item.section_id === node.section_id && item.segment === node.segment,
  );
  const fullSource = extractNodeSourceFromHtml(rawHtml, node.section_id, node.segment);
  let source = fullSource;
  let range = {
    start: { block_index: fullSource.blocks[0]?.block_index ?? 1, offset: 0 },
    end: {
      block_index: fullSource.blocks.at(-1)?.block_index ?? 1,
      offset: fullSource.blocks.at(-1)?.text.length ?? 0,
    },
  };
  if (segment) {
    range = {
      start: { block_index: segment.startBlockIndex, offset: segment.startOffset },
      end: { block_index: segment.endBlockIndex, offset: segment.endOffset },
    };
    source = sliceNodeSource(fullSource, range);
  }
  const base = {
    user_id: row.userBook.userId,
    package_id: row.package.id,
    package_version: row.package.version,
    profiles: {
      book: { version: row.package.id, value: bookProfile },
      reader: { version: reader.id, value: jsonValue(reader.profile) },
      book_reader: { version: bookReader.id, value: jsonValue(bookReader.profile) },
    },
    source: {
      section_id: node.section_id,
      segment: node.segment,
      node_order: node.order,
      title: node.title ?? null,
      ancestor_titles: ancestorTitles(node, manifest.outline),
      range,
      structured_html: source.structuredHtml,
      blocks: source.blocks,
      original_notes: source.originalNotes as JsonValue[],
      previous_context: contextExcerpt(rawHtml, eligible[eligibleIndex - 1], 'end'),
      next_context: contextExcerpt(rawHtml, eligible[eligibleIndex + 1], 'start'),
    },
    model: {
      model_id: options.model.name,
      config_version: row.generation.modelConfigId,
    },
  };
  const input: TailoringGenerationInput = row.generation.generationScope === 'trial'
    ? {
        ...base,
        generation_scope: 'trial',
        fragment_range: range,
        strategy: {
          kind: 'strategy_draft',
          version: draft?.id ?? '',
          status: 'approved_for_trial',
          value: jsonValue(draft?.strategy),
        },
      }
    : {
        ...base,
        generation_scope: 'formal',
        strategy: {
          kind: 'strategy',
          version: formalStrategy?.id ?? '',
          status: 'active',
          value: jsonValue(formalStrategy?.strategy),
        },
      };
  if (input.generation_scope === 'trial' && draft?.status !== 'approved_for_trial') {
    throw new Error('trial generation draft is no longer approved');
  }
  if (input.generation_scope === 'formal' && !formalStrategy) {
    throw new Error('formal generation strategy is missing');
  }

  const cacheKey = createTailoringCacheKey(input);
  const [cached] = await options.db
    .select()
    .from(nodeGenerations)
    .where(and(eq(nodeGenerations.cacheKey, cacheKey), eq(nodeGenerations.status, 'ready')))
    .limit(1);
  const claimedAttempt = await options.db.transaction(async (tx) => {
    if (row.generation.generationScope === 'trial') {
      if (!segment || !row.generation.trialSegmentId || !row.generation.strategyDraftVersionId) {
        throw new Error('trial generation references are incomplete');
      }
      const graph = await lockTrialGenerationGraph(tx, row.generation, {
        id: segment.id,
        trialRevisionId: segment.trialRevisionId,
      });
      if (!graphIsCurrent(graph)) {
        await supersedeStaleTrialGeneration(tx, row.generation.id);
        return null;
      }
      if (!['queued', 'retrying', 'generating'].includes(graph.generation.status)) return null;
      if (!['pending', 'generating'].includes(graph.segment.status)) return null;
      const attemptCount = nextGenerationAttempt(
        graph.generation.attemptCount,
        graph.generation.maxAttempts,
      );
      if (!attemptCount) {
        throw errorForGenerationAttempt(
          new Error('content generation attempts are exhausted'),
          graph.generation.attemptCount,
        );
      }
      const [started] = await tx
        .update(nodeGenerations)
        .set({
          status: 'generating',
          attemptCount,
          cacheKey,
          startedAt: new Date(),
          completedAt: null,
          errorSummary: null,
          updatedAt: new Date(),
        })
        .where(and(
          eq(nodeGenerations.id, graph.generation.id),
          eq(nodeGenerations.attemptCount, graph.generation.attemptCount),
          inArray(nodeGenerations.status, ['queued', 'retrying', 'generating']),
        ))
        .returning({ id: nodeGenerations.id });
      if (!started) return null;
      const [startedSegment] = await tx
        .update(trialSegments)
        .set({ status: 'generating', updatedAt: new Date() })
        .where(and(
          eq(trialSegments.id, graph.segment.id),
          inArray(trialSegments.status, ['pending', 'generating']),
        ))
        .returning({ id: trialSegments.id });
      if (!startedSegment) throw new Error('trial segment could not enter generating');
      return attemptCount;
    }

    const attemptCount = nextGenerationAttempt(
      row.generation.attemptCount,
      row.generation.maxAttempts,
    );
    if (!attemptCount) {
      throw errorForGenerationAttempt(
        new Error('content generation attempts are exhausted'),
        row.generation.attemptCount,
      );
    }
    const [started] = await tx
      .update(nodeGenerations)
      .set({
        status: 'generating',
        attemptCount,
        cacheKey,
        startedAt: new Date(),
        completedAt: null,
        errorSummary: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(nodeGenerations.id, row.generation.id),
        eq(nodeGenerations.attemptCount, row.generation.attemptCount),
        inArray(nodeGenerations.status, ['queued', 'retrying', 'generating']),
      ))
      .returning({ id: nodeGenerations.id });
    return started ? attemptCount : null;
  });
  if (!claimedAttempt) return;

  try {
    const generated = cached?.result
      ? {
          guide: cached.result.guide,
          annotations: cached.result.annotations.map((annotation) => ({
            range: {
              start: { block_index: annotation.range.start.blockIndex, offset: annotation.range.start.offset },
              end: { block_index: annotation.range.end.blockIndex, offset: annotation.range.end.offset },
            },
            content: annotation.content,
          })),
          after_reading: cached.result.afterReading,
        }
      : await generateTailoredContent(
          input,
          createModelClient(options.model, {
            ...(options.perfSink ? { perfSink: options.perfSink } : {}),
            requestId: options.generationId,
          }),
        );
    const result = {
      guide: generated.guide,
      annotations: generated.annotations.map((annotation, index) => ({
        id: `${row.generation.id}:${index + 1}`,
        range: {
          start: { blockIndex: annotation.range.start.block_index, offset: annotation.range.start.offset },
          end: { blockIndex: annotation.range.end.block_index, offset: annotation.range.end.offset },
        },
        content: annotation.content,
      })),
      afterReading: generated.after_reading,
    };
    await finalizeContentGeneration({
      db: options.db,
      generation: row.generation,
      ...(segment ? { trialSegment: segment } : {}),
      claimedAttempt,
      result,
    });
  } catch (error) {
    throw errorForGenerationAttempt(error, claimedAttempt);
  }
}

export async function failContentGeneration(options: {
  db: Database;
  generationId: string;
  error: Error;
}) {
  const expectedAttemptCount = generationAttemptFromError(options.error);
  const [initialGeneration] = await options.db
    .select()
    .from(nodeGenerations)
    .where(eq(nodeGenerations.id, options.generationId))
    .limit(1);
  if (!initialGeneration) return;
  const initialSegment = initialGeneration.trialSegmentId
    ? await options.db
        .select()
        .from(trialSegments)
        .where(eq(trialSegments.id, initialGeneration.trialSegmentId))
        .limit(1)
        .then((rows) => rows[0])
    : undefined;
  await options.db.transaction(async (tx) => {
    if (initialGeneration.generationScope !== 'trial' || !initialSegment) {
      await tx
        .update(nodeGenerations)
        .set({
          status: 'failed',
          result: null,
          errorSummary: options.error.message.slice(0, 1000),
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(nodeGenerations.id, options.generationId),
          inArray(nodeGenerations.status, ['queued', 'generating', 'retrying']),
          expectedAttemptCount === undefined
            ? undefined
            : eq(nodeGenerations.attemptCount, expectedAttemptCount),
        ));
      return;
    }

    const graph = await lockTrialGenerationGraph(tx, initialGeneration, {
      id: initialSegment.id,
      trialRevisionId: initialSegment.trialRevisionId,
    });
    if (!graphIsCurrent(graph)) {
      await supersedeStaleTrialGeneration(tx, options.generationId, expectedAttemptCount);
      return;
    }
    if (
      expectedAttemptCount !== undefined
      && graph.generation.attemptCount !== expectedAttemptCount
    ) return;
    if (!['queued', 'generating', 'retrying'].includes(graph.generation.status)) return;

    const siblingSegments = await tx
      .select({ id: trialSegments.id, status: trialSegments.status })
      .from(trialSegments)
      .where(eq(trialSegments.trialRevisionId, graph.revision.id));
    const siblingIds = trialSegmentIdsToFail(siblingSegments);
    const now = new Date();
    if (siblingIds.length > 0) {
      await tx
        .update(nodeGenerations)
        .set({
          status: 'failed',
          result: null,
          errorSummary: options.error.message.slice(0, 1000),
          completedAt: now,
          updatedAt: now,
        })
        .where(and(
          inArray(nodeGenerations.trialSegmentId, siblingIds),
          inArray(nodeGenerations.status, ['queued', 'generating', 'retrying']),
        ));
      await tx
        .update(trialSegments)
        .set({ status: 'failed', updatedAt: now })
        .where(inArray(trialSegments.id, siblingIds));
    }
    const [failed] = await tx
      .update(trialRevisions)
      .set({
        status: 'failed',
        failureSummary: '试读内容生成失败，请重试当前版本。',
        failedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(trialRevisions.id, graph.revision.id),
        eq(trialRevisions.status, 'generating'),
      ))
      .returning({ id: trialRevisions.id });
    if (!failed) return;
    const [advanced] = await tx
      .update(userBooks)
      .set({ workflowStatus: 'trial_generation_failed', updatedAt: now })
      .where(and(
        eq(userBooks.id, graph.userBook.id),
        eq(userBooks.currentStrategyDraftVersionId, graph.draft.id),
        eq(userBooks.currentTrialRevisionId, graph.revision.id),
        eq(userBooks.workflowStatus, 'trial_generating'),
      ))
      .returning({ id: userBooks.id });
    if (!advanced) throw new Error('trial generation failed after its current pointer changed');
  });
}
