import { describe, expect, it } from 'vitest';
import {
  nodeGenerations,
  readerReadNodes,
  readerStates,
  userBooks,
} from '@readtailor/database';
import {
  discardUnexpectedFormalGeneration,
  isCurrentTrialGenerationGraph,
  nextGenerationAttempt,
  shouldPublishTrialRevision,
  trialSegmentIdsToFail,
  type TrialGenerationGraphCheck,
} from './job';

type Generation = Parameters<typeof discardUnexpectedFormalGeneration>[1] & {
  status: 'queued' | 'superseded';
};

describe('formal generation expectation', () => {
  it('releases the unique key when a superseded version later becomes expected', async () => {
    const strategyA = '00000000-0000-4000-8000-00000000000a';
    const strategyB = '00000000-0000-4000-8000-00000000000b';
    const generation: Generation = {
      id: '00000000-0000-4000-8000-000000000001',
      userBookId: '00000000-0000-4000-8000-000000000002',
      strategyVersionId: strategyB,
      sectionId: 'chapter-2',
      segment: 1,
      status: 'queued',
    };
    const generations: Generation[] = [generation];
    let currentNode = { sectionId: 'chapter-3', segment: 1 };
    const transitions: string[] = [];

    const rowsFor = (table: unknown) => {
      if (table === userBooks) return [{ strategyVersionId: strategyB }];
      if (table === readerStates) return [currentNode];
      if (table === readerReadNodes) return [{ strategyVersionId: strategyA }];
      throw new Error('unexpected table');
    };
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: () => ({
              for: () => Promise.resolve(rowsFor(table)),
            }),
          }),
        }),
      }),
      update: (table: unknown) => {
        expect(table).toBe(nodeGenerations);
        return {
          set: (values: { status: Generation['status'] }) => ({
            where: () => ({
              returning: () => {
                const current = generations.find((item) => item.id === generation.id);
                if (!current) return [];
                current.status = values.status;
                transitions.push(values.status);
                return [{ id: generation.id }];
              },
            }),
          }),
        };
      },
    } as unknown as Parameters<typeof discardUnexpectedFormalGeneration>[0];

    await expect(discardUnexpectedFormalGeneration(db, generation)).resolves.toBe(true);
    expect(transitions).toEqual(['superseded']);
    expect(generations).toEqual([{ ...generation, status: 'superseded' }]);

    currentNode = { sectionId: generation.sectionId, segment: generation.segment };
    const replacement = {
      ...generation,
      id: '00000000-0000-4000-8000-000000000003',
      status: 'queued' as const,
    };
    const activeWithSameKey = generations.find((item) => item.status !== 'superseded');
    if (activeWithSameKey) throw new Error('formal generation unique key is still occupied');
    generations.push(replacement);

    await expect(discardUnexpectedFormalGeneration(db, replacement)).resolves.toBe(false);
    expect(generations).toEqual([
      { ...generation, status: 'superseded' },
      replacement,
    ]);
    expect(transitions).toEqual(['superseded']);
  });
});

const currentTrialGraph: TrialGenerationGraphCheck = {
  generation: {
    userBookId: 'book-1',
    generationScope: 'trial',
    trialSegmentId: 'segment-1',
    strategyDraftVersionId: 'draft-1',
    sectionId: 'chapter-1',
    segment: 1,
  },
  segment: {
    id: 'segment-1',
    trialRevisionId: 'revision-1',
    sectionId: 'chapter-1',
    segment: 1,
  },
  revision: {
    id: 'revision-1',
    userBookId: 'book-1',
    strategyDraftVersionId: 'draft-1',
    status: 'generating',
  },
  draft: {
    id: 'draft-1',
    status: 'approved_for_trial',
  },
  userBook: {
    id: 'book-1',
    workflowStatus: 'trial_generating',
    currentStrategyDraftVersionId: 'draft-1',
    currentTrialRevisionId: 'revision-1',
  },
};

describe('trial generation fencing', () => {
  it('accepts only the current revision, draft, segment and book pointer graph', () => {
    expect(isCurrentTrialGenerationGraph(currentTrialGraph)).toBe(true);

    const staleGraphs: TrialGenerationGraphCheck[] = [
      {
        ...currentTrialGraph,
        userBook: { ...currentTrialGraph.userBook, currentTrialRevisionId: 'revision-2' },
      },
      {
        ...currentTrialGraph,
        userBook: { ...currentTrialGraph.userBook, workflowStatus: 'trial_generation_failed' },
      },
      {
        ...currentTrialGraph,
        revision: { ...currentTrialGraph.revision, status: 'superseded' },
      },
      {
        ...currentTrialGraph,
        draft: { ...currentTrialGraph.draft, status: 'superseded' },
      },
      {
        ...currentTrialGraph,
        generation: { ...currentTrialGraph.generation, trialSegmentId: 'segment-2' },
      },
      {
        ...currentTrialGraph,
        generation: { ...currentTrialGraph.generation, strategyDraftVersionId: 'draft-2' },
      },
      {
        ...currentTrialGraph,
        generation: { ...currentTrialGraph.generation, sectionId: 'chapter-2' },
      },
    ];

    for (const graph of staleGraphs) {
      expect(isCurrentTrialGenerationGraph(graph)).toBe(false);
    }
  });

  it('issues a monotonic attempt token and refuses claims past maxAttempts', () => {
    expect(nextGenerationAttempt(0, 3)).toBe(1);
    expect(nextGenerationAttempt(1, 3)).toBe(2);
    expect(nextGenerationAttempt(2, 3)).toBe(3);
    expect(nextGenerationAttempt(3, 3)).toBeNull();
  });

  it('publishes only one complete set of three unique ready slots', () => {
    expect(shouldPublishTrialRevision([
      { ordinal: 1, status: 'ready' },
      { ordinal: 2, status: 'ready' },
    ])).toBe(false);
    expect(shouldPublishTrialRevision([
      { ordinal: 1, status: 'ready' },
      { ordinal: 2, status: 'generating' },
      { ordinal: 3, status: 'ready' },
    ])).toBe(false);
    expect(shouldPublishTrialRevision([
      { ordinal: 1, status: 'ready' },
      { ordinal: 1, status: 'ready' },
      { ordinal: 3, status: 'ready' },
    ])).toBe(false);
    expect(shouldPublishTrialRevision([
      { ordinal: 1, status: 'ready' },
      { ordinal: 2, status: 'ready' },
      { ordinal: 3, status: 'ready' },
    ])).toBe(true);
  });

  it('freezes unfinished siblings after a terminal failure and preserves ready results', () => {
    expect(trialSegmentIdsToFail([
      { id: 'segment-1', status: 'ready' },
      { id: 'segment-2', status: 'generating' },
      { id: 'segment-3', status: 'pending' },
    ])).toEqual(['segment-2', 'segment-3']);
    expect(trialSegmentIdsToFail([
      { id: 'segment-1', status: 'ready' },
      { id: 'segment-2', status: 'failed' },
      { id: 'segment-3', status: 'ready' },
    ])).toEqual([]);
  });
});
