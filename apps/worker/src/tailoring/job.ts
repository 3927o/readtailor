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
  if (row.generation.status === 'ready' || row.generation.status === 'superseded') return;
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
  const started = await options.db
    .update(nodeGenerations)
    .set({
      status: 'generating',
      attemptCount: Math.min(row.generation.attemptCount + 1, row.generation.maxAttempts),
      cacheKey,
      startedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(nodeGenerations.id, row.generation.id),
      inArray(nodeGenerations.status, ['queued', 'retrying', 'generating']),
    ))
    .returning({ id: nodeGenerations.id });
  if (started.length === 0) return;
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
  await options.db.transaction(async (tx) => {
    if (
      row.generation.generationScope === 'formal'
      && await discardUnexpectedFormalGeneration(tx, row.generation)
    ) return;
    const [current] = await tx
      .update(nodeGenerations)
      .set({ status: 'ready', result, completedAt: new Date(), errorSummary: null, updatedAt: new Date() })
      .where(and(eq(nodeGenerations.id, row.generation.id), eq(nodeGenerations.status, 'generating')))
      .returning();
    if (!current) return;
    if (!current.trialSegmentId) return;
    const changedSegment = await tx
      .update(trialSegments)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(and(
        eq(trialSegments.id, current.trialSegmentId),
        inArray(trialSegments.status, ['pending', 'generating']),
      ))
      .returning({ id: trialSegments.id, trialRevisionId: trialSegments.trialRevisionId });
    const trialSegment = changedSegment[0];
    if (!trialSegment) return;
    // Serialize the all-ready check + publish across the three concurrent segment jobs. Without
    // this row lock, under READ COMMITTED two siblings finishing at once each miss the other's
    // uncommitted `ready`, so neither publishes and the revision is stranded in `generating`
    // (§6.3). Locking the revision row first forces the last job through here to observe every
    // committed sibling and publish. Also serializes against the failure path's revision UPDATE.
    await tx
      .select({ id: trialRevisions.id })
      .from(trialRevisions)
      .where(eq(trialRevisions.id, trialSegment.trialRevisionId))
      .limit(1)
      .for('update');
    const siblings = await tx.select().from(trialSegments).where(eq(trialSegments.trialRevisionId, trialSegment.trialRevisionId));
    const allReady = siblings.length === 3 && siblings.every((item) => item.id === trialSegment.id ? true : item.status === 'ready');
    if (!allReady) return;
    const [revision] = await tx
      .update(trialRevisions)
      .set({ status: 'published', publishedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(trialRevisions.id, trialSegment.trialRevisionId),
        eq(trialRevisions.status, 'generating'),
      ))
      .returning();
    if (!revision) return;
    await tx
      .update(userBooks)
      .set({ workflowStatus: 'trial_review', updatedAt: new Date() })
      .where(and(
        eq(userBooks.id, revision.userBookId),
        eq(userBooks.currentTrialRevisionId, revision.id),
        eq(userBooks.workflowStatus, 'trial_generating'),
      ));
  });
}

export async function failContentGeneration(options: {
  db: Database;
  generationId: string;
  error: Error;
}) {
  await options.db.transaction(async (tx) => {
    const [generation] = await tx
      .update(nodeGenerations)
      .set({
        status: 'failed',
        errorSummary: options.error.message.slice(0, 1000),
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(nodeGenerations.id, options.generationId),
        inArray(nodeGenerations.status, ['queued', 'generating', 'retrying']),
      ))
      .returning();
    if (!generation) return;
    if (!generation.trialSegmentId) return;
    await tx.update(trialSegments).set({ status: 'failed', updatedAt: new Date() }).where(eq(trialSegments.id, generation.trialSegmentId));
    const [segment] = await tx.select().from(trialSegments).where(eq(trialSegments.id, generation.trialSegmentId)).limit(1);
    if (!segment) return;
    const [revision] = await tx.select().from(trialRevisions).where(eq(trialRevisions.id, segment.trialRevisionId)).limit(1);
    if (!revision || revision.status !== 'generating') return;
    const [owner] = await tx.select().from(userBooks).where(eq(userBooks.id, revision.userBookId)).limit(1);
    if (!owner || owner.currentTrialRevisionId !== revision.id) return;
    const failed = await tx.update(trialRevisions).set({
        status: 'failed',
        failureSummary: '试读内容生成失败，请重试当前版本。',
        failedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(trialRevisions.id, segment.trialRevisionId),
        eq(trialRevisions.status, 'generating'),
      )).returning({ id: trialRevisions.id });
    if (failed.length === 0) return;
    await tx.update(userBooks).set({ workflowStatus: 'trial_generation_failed', updatedAt: new Date() }).where(and(
      eq(userBooks.id, revision.userBookId),
      eq(userBooks.currentTrialRevisionId, revision.id),
      eq(userBooks.workflowStatus, 'trial_generating'),
    ));
  });
}
