import { describe, expect, it } from 'vitest';
import {
  nodeGenerations,
  readerReadNodes,
  readerStates,
  userBooks,
} from '@readtailor/database';
import { discardUnexpectedFormalGeneration } from './job';

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
