/** Executes database-backed formal tailoring generations and fences stale results. */

import { and, eq, inArray } from 'drizzle-orm';
import type { JsonValue, TailoringGenerationInput, TailoringModelClient } from '@readtailor/tailoring';
import {
  createTailoringCacheKey,
  extractNodeSourceFromHtml,
  generateTailoredContent,
} from '@readtailor/tailoring';
import {
  createManifestIndex,
  requireNode,
  type ManifestIndex,
  type ReadingManifestNode,
} from '@readtailor/reader-core';
import {
  bookPackages,
  bookReaderProfileVersions,
  nodeGenerations,
  readerProfiles,
  readerProfileVersions,
  readerReadNodes,
  readerStates,
  sharedBooks,
  strategyVersions,
  userBooks,
  type Database,
} from '@readtailor/database';
import type { ModelEngine } from '@readtailor/model';
import type { PerfSink } from '@readtailor/observability';
import type { ObjectStorage } from '@readtailor/storage';
import { readPublishedReadingManifestJson } from '../reading-manifest';

function jsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

function ancestorTitles(node: ReadingManifestNode, manifestIndex: ManifestIndex): string[] {
  const titles: string[] = [];
  let parent = node.parentSectionId
    ? manifestIndex.outlineBySectionId.get(node.parentSectionId)
    : undefined;
  while (parent) {
    if (parent.title.trim()) titles.unshift(parent.title.trim());
    parent = parent.parentSectionId
      ? manifestIndex.outlineBySectionId.get(parent.parentSectionId)
      : undefined;
  }
  return titles;
}

function contextExcerpt(
  rawHtml: string,
  node: ReadingManifestNode | undefined,
  edge: 'start' | 'end',
): string | null {
  if (!node) return null;
  const source = extractNodeSourceFromHtml(rawHtml, node.sectionId, node.segment);
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
          afterReading: '读完后，可以用一句话复述这一段在全书主线中的作用。',
        });
      }
      const started = performance.now();
      let content = '';
      try {
        for await (const event of engine.streamChat(request.prompt, {
          maxTokens: 4096,
          responseFormat: request.responseFormat,
        })) {
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

export function nextGenerationAttempt(attemptCount: number, maxAttempts: number): number | null {
  return attemptCount >= maxAttempts ? null : attemptCount + 1;
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
  claimedAttempt: number;
  result: ReadyGenerationResult;
}): Promise<void> {
  if (options.generation.generationScope !== 'formal') {
    throw new Error('content generation worker only supports formal generations');
  }
  await options.db.transaction(async (tx) => {
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
  if (row.generation.generationScope !== 'formal') {
    throw new Error('content generation worker only supports formal generations');
  }
  if (await options.db.transaction((tx) => discardUnexpectedFormalGeneration(tx, row.generation))) {
    return;
  }

  const [reader, bookReader, formalStrategy] = await Promise.all([
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
    row.generation.strategyVersionId
      ? options.db.select().from(strategyVersions).where(eq(strategyVersions.id, row.generation.strategyVersionId)).limit(1).then((rows) => rows[0])
      : Promise.resolve(undefined),
  ]);
  if (!reader || !bookReader) throw new Error('generation profiles are incomplete');
  if (!formalStrategy) throw new Error('formal generation strategy is missing');

  const [htmlBytes, manifestBytes, bookProfileBytes] = await Promise.all([
    options.storage.get(`${row.package.objectPrefix}/book.normalized.html`),
    options.storage.get(`${row.package.objectPrefix}/reading_manifest.json`),
    options.storage.get(`${row.package.objectPrefix}/book_profile.json`),
  ]);
  const rawHtml = new TextDecoder().decode(htmlBytes);
  const manifest = readPublishedReadingManifestJson(new TextDecoder().decode(manifestBytes));
  const manifestIndex = createManifestIndex(manifest);
  const bookProfile = JSON.parse(new TextDecoder().decode(bookProfileBytes)) as JsonValue;
  const node = requireNode(
    manifestIndex,
    row.generation.sectionId,
    row.generation.segment,
  );
  const eligible = manifest.nodes.filter((item) => item.tailoringEligible);
  const eligibleIndex = eligible.findIndex(
    (item) => item.sectionId === node.sectionId && item.segment === node.segment,
  );
  const fullSource = extractNodeSourceFromHtml(rawHtml, node.sectionId, node.segment);
  const source = fullSource;
  const range = {
    start: { blockIndex: fullSource.blocks[0]?.blockIndex ?? 1, offset: 0 },
    end: {
      blockIndex: fullSource.blocks.at(-1)?.blockIndex ?? 1,
      offset: fullSource.blocks.at(-1)?.text.length ?? 0,
    },
  };
  const base = {
    userId: row.userBook.userId,
    packageId: row.package.id,
    packageVersion: row.package.version,
    profiles: {
      book: { version: row.package.id, value: bookProfile },
      reader: { version: reader.id, value: jsonValue(reader.profile) },
      bookReader: { version: bookReader.id, value: jsonValue(bookReader.profile) },
    },
    source: {
      sectionId: node.sectionId,
      segment: node.segment,
      nodeOrder: node.order,
      title: node.title ?? null,
      ancestorTitles: ancestorTitles(node, manifestIndex),
      range,
      structuredHtml: source.structuredHtml,
      blocks: source.blocks,
      originalNotes: source.originalNotes as JsonValue[],
      previousContext: contextExcerpt(rawHtml, eligible[eligibleIndex - 1], 'end'),
      nextContext: contextExcerpt(rawHtml, eligible[eligibleIndex + 1], 'start'),
    },
    model: {
      modelId: options.model.name,
      configVersion: row.generation.modelConfigId,
    },
  };
  const input: TailoringGenerationInput = {
    ...base,
    generationScope: 'formal',
    strategy: {
      kind: 'strategy',
      version: formalStrategy.id,
      status: 'active',
      value: jsonValue(formalStrategy.strategy),
    },
  };

  const cacheKey = createTailoringCacheKey(input);
  const [cached] = await options.db
    .select()
    .from(nodeGenerations)
    .where(and(eq(nodeGenerations.cacheKey, cacheKey), eq(nodeGenerations.status, 'ready')))
    .limit(1);
  const claimedAttempt = await options.db.transaction(async (tx) => {
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
            range: annotation.range,
            content: annotation.content,
          })),
          afterReading: cached.result.afterReading,
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
          start: annotation.range.start,
          end: annotation.range.end,
        },
        content: annotation.content,
      })),
      afterReading: generated.afterReading,
    };
    await finalizeContentGeneration({
      db: options.db,
      generation: row.generation,
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
  await options.db
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
      eq(nodeGenerations.generationScope, 'formal'),
      inArray(nodeGenerations.status, ['queued', 'generating', 'retrying']),
      expectedAttemptCount === undefined
        ? undefined
        : eq(nodeGenerations.attemptCount, expectedAttemptCount),
    ));
}
