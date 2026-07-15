import { describe, expect, it, vi } from 'vitest';
import {
  bookReaderProfileVersions,
  interviewSessions,
  nodeGenerations,
  strategyDraftVersions,
  strategyVersions,
  trialRevisions,
  trialSegments,
  userBooks,
} from '@readtailor/database';
import type { PresetBookTemplate } from './preset-book-templates';
import { bindPresetBooks, hydratePresetUserBook } from './preset-books';

// A minimal stand-in for the drizzle transaction chain used by bindPresetBooks:
//   tx.select({...}).from(t).where(cond)                                   → Promise<rows>
//   tx.insert(t).values(rows).onConflictDoNothing(cfg).returning(cols)     → Promise<rows>
function fakeTx(options: {
  presetIds?: string[];
  presetRows?: Array<{
    id: string;
    title: string;
    epubSha256: string;
    packageVersion: string;
    manifestVersion: string;
    fileHashes: Record<string, string>;
  }>;
  insertedIds: string[];
}) {
  const presetIds = options.presetIds ?? options.presetRows?.map((row) => row.id) ?? [];
  const presetRows =
    options.presetRows ??
    presetIds.map((id) => ({
      id,
      title: id,
      epubSha256: `untemplated-${id}`,
      packageVersion: 'package-v1',
      manifestVersion: 'manifest-v1',
      fileHashes: {},
    }));
  const insertValues = vi.fn();
  const onConflict = vi.fn();
  const tx = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => Promise.resolve(presetRows),
        }),
      }),
    }),
    insert: () => ({
      values: (rows: unknown) => {
        insertValues(rows);
        return {
          onConflictDoNothing: (cfg: unknown) => {
            onConflict(cfg);
            return {
              returning: () =>
                Promise.resolve(
                  options.insertedIds.map((id, index) => ({
                    id,
                    sharedBookId: presetIds[index],
                  })),
                ),
            };
          },
        };
      },
    }),
  };
  return { tx, insertValues, onConflict };
}

const sampleTemplate: PresetBookTemplate = {
  schemaVersion: 1,
  key: 'sample-v1',
  source: { userBookId: 'source-user-book', sharedBookId: 'source-shared-book' },
  book: {
    title: 'Sample',
    epubSha256: 'a'.repeat(64),
    packageVersion: 'package-v1',
    manifestVersion: 'manifest-v1',
    readingManifestSha256: 'b'.repeat(64),
  },
  profile: {
    purpose: 'read deeply',
    likelyObstacles: [],
    otherConclusions: [],
    existingKnowledge: [],
    expectedCommitment: 'finish it',
    desiredDepthOrOutcome: 'understand it',
  },
  readingBriefing: {
    bookIdentity: 'identity',
    arc: 'arc',
    assumedKnowledge: 'knowledge',
    readingAdvice: 'advice',
  },
  userFacingSummary: 'summary',
  strategy: {
    goals: ['goal'],
    expressionPrinciples: ['concise'],
    guide: {
      enabled: true,
      objectives: ['orient the reader'],
    },
    annotations: {
      enabled: true,
      focuses: ['concept'],
      exclusions: ['obvious'],
    },
    afterReading: {
      enabled: true,
      objectives: ['recap'],
    },
    trialCandidates: [
      { sectionId: 'section-1', segment: 1, reason: 'entry' },
      { sectionId: 'section-2', segment: 1, reason: 'typical' },
      { sectionId: 'section-3', segment: 1, reason: 'hardest' },
    ],
  },
  trial: {
    segments: [
      {
        ordinal: 1,
        sectionId: 'section-1',
        segment: 1,
        startBlockIndex: 1,
        startOffset: 0,
        endBlockIndex: 1,
        endOffset: 5,
        selectionReason: 'entry',
        generation: {
          sectionId: 'section-1',
          segment: 1,
          result: { guide: 'guide', annotations: [], afterReading: null },
          modelConfigId: 'model',
          promptVersion: 'prompt-v1',
          attemptCount: 1,
          maxAttempts: 3,
        },
      },
    ],
  },
  formalGenerations: [
    {
      sectionId: 'section-1',
      segment: 1,
      result: { guide: 'guide', annotations: [], afterReading: 'recap' },
      modelConfigId: 'model',
      promptVersion: 'prompt-v1',
      attemptCount: 1,
      maxAttempts: 3,
    },
  ],
};

function fakeHydrationTx() {
  const inserts: Array<{ table: unknown; values: any }> = [];
  const updates: Array<{ table: unknown; values: any }> = [];
  const ids = new Map<unknown, string>([
    [interviewSessions, 'interview-1'],
    [bookReaderProfileVersions, 'profile-1'],
    [strategyDraftVersions, 'draft-1'],
    [strategyVersions, 'strategy-1'],
    [trialRevisions, 'trial-1'],
  ]);

  const tx = {
    insert: (table: unknown) => ({
      values: (values: any) => {
        inserts.push({ table, values });
        const result = {
          returning: async () => {
            if (table === trialSegments) {
              return values.map((segment: any) => ({
                id: `trial-segment-${segment.ordinal}`,
                ordinal: segment.ordinal,
              }));
            }
            const id = ids.get(table);
            return id ? [{ id }] : [];
          },
          then: (resolve: (value: undefined) => void) => resolve(undefined),
        };
        return result;
      },
    }),
    update: (table: unknown) => ({
      set: (values: any) => ({
        where: async () => {
          updates.push({ table, values });
        },
      }),
    }),
  };
  return { tx, inserts, updates };
}

describe('bindPresetBooks', () => {
  it('inserts one user_book per preset shared book, keyed to the user', async () => {
    const { tx, insertValues, onConflict } = fakeTx({
      presetIds: ['book-a', 'book-b'],
      insertedIds: ['ub-a', 'ub-b'],
    });

    const added = await bindPresetBooks(tx as any, 'user-1');

    expect(added).toBe(2);
    expect(insertValues).toHaveBeenCalledWith([
      { userId: 'user-1', sharedBookId: 'book-a' },
      { userId: 'user-1', sharedBookId: 'book-b' },
    ]);
    // Idempotency guard: dedupe on the (user, shared book) unique index rather than resurrecting.
    expect(onConflict).toHaveBeenCalledWith({
      target: [userBooks.userId, userBooks.sharedBookId],
    });
  });

  it('reports zero newly-added books on an idempotent replay (all conflicts)', async () => {
    const { tx, insertValues } = fakeTx({ presetIds: ['book-a'], insertedIds: [] });

    const added = await bindPresetBooks(tx as any, 'user-1');

    expect(added).toBe(0);
    expect(insertValues).toHaveBeenCalledOnce();
  });

  it('does not hydrate the Zarathustra template on an idempotent replay', async () => {
    const { tx, insertValues } = fakeTx({
      presetRows: [
        {
          id: 'fd61c01c-2a18-484c-af8f-87cadbbb8989',
          title: '查拉图斯特拉如是说',
          epubSha256: '5814044076bd72c553087c0166b65b635897b54499187f787036569abb81a6f6',
          packageVersion: 'nb-1.0-v3',
          manifestVersion: 'reading-nodes-1.0',
          fileHashes: {
            'reading_manifest.json':
              'f97fc41a497fa7c72493026d2c4d66cb385055fe870992453023fd56fcefa851',
          },
        },
      ],
      insertedIds: [],
    });

    const added = await bindPresetBooks(tx as any, 'user-1');

    expect(added).toBe(0);
    expect(insertValues).toHaveBeenCalledOnce();
  });

  it('does not touch user_books when no preset books are configured', async () => {
    const { tx, insertValues } = fakeTx({ presetIds: [], insertedIds: [] });

    const added = await bindPresetBooks(tx as any, 'user-1');

    expect(added).toBe(0);
    expect(insertValues).not.toHaveBeenCalled();
  });
});

describe('hydratePresetUserBook', () => {
  it('creates an active reading setup with remapped trial and formal generations', async () => {
    const { tx, inserts, updates } = fakeHydrationTx();
    const now = new Date('2026-07-15T00:00:00.000Z');

    await hydratePresetUserBook(tx as any, 'target-user-book', sampleTemplate, now);

    expect(inserts.map((insert) => insert.table)).toEqual([
      interviewSessions,
      bookReaderProfileVersions,
      strategyDraftVersions,
      strategyVersions,
      trialRevisions,
      trialSegments,
      nodeGenerations,
      nodeGenerations,
    ]);

    const trialGeneration = inserts[6]?.values[0];
    expect(trialGeneration).toMatchObject({
      userBookId: 'target-user-book',
      generationScope: 'trial',
      trialSegmentId: 'trial-segment-1',
      strategyDraftVersionId: 'draft-1',
      status: 'ready',
      cacheKey: 'preset:sample-v1:target-user-book:trial:1',
    });
    const formalGeneration = inserts[7]?.values[0];
    expect(formalGeneration).toMatchObject({
      userBookId: 'target-user-book',
      generationScope: 'formal',
      strategyVersionId: 'strategy-1',
      status: 'ready',
      cacheKey: 'preset:sample-v1:target-user-book:formal:section-1:1',
    });
    expect(updates).toEqual([
      {
        table: userBooks,
        values: {
          workflowStatus: 'active_reading',
          currentInterviewSessionId: 'interview-1',
          currentBookReaderProfileVersionId: 'profile-1',
          currentStrategyDraftVersionId: 'draft-1',
          currentStrategyVersionId: 'strategy-1',
          currentTrialRevisionId: 'trial-1',
          updatedAt: now,
        },
      },
    ]);
  });
});
