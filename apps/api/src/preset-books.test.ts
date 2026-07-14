import { describe, expect, it, vi } from 'vitest';
import { userBooks } from '@readtailor/database';
import { bindPresetBooks } from './preset-books';

// A minimal stand-in for the drizzle transaction chain used by bindPresetBooks:
//   tx.select({...}).from(t).where(cond)                                   → Promise<rows>
//   tx.insert(t).values(rows).onConflictDoNothing(cfg).returning(cols)     → Promise<rows>
function fakeTx(options: {
  presetIds: string[];
  insertedIds: string[];
}) {
  const insertValues = vi.fn();
  const onConflict = vi.fn();
  const tx = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(options.presetIds.map((id) => ({ id }))),
      }),
    }),
    insert: () => ({
      values: (rows: unknown) => {
        insertValues(rows);
        return {
          onConflictDoNothing: (cfg: unknown) => {
            onConflict(cfg);
            return {
              returning: () => Promise.resolve(options.insertedIds.map((id) => ({ id }))),
            };
          },
        };
      },
    }),
  };
  return { tx, insertValues, onConflict };
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

  it('does not touch user_books when no preset books are configured', async () => {
    const { tx, insertValues } = fakeTx({ presetIds: [], insertedIds: [] });

    const added = await bindPresetBooks(tx as any, 'user-1');

    expect(added).toBe(0);
    expect(insertValues).not.toHaveBeenCalled();
  });
});
