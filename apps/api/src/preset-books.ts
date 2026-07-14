import { eq } from 'drizzle-orm';
import { sharedBooks, userBooks, type Database } from '@readtailor/database';

// A transaction handle from `db.transaction`. Preset binding always runs inside the onboarding
// transaction so completing the profile and stocking the shelf commit atomically (PRD §5.2 / §19.1).
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

// §预置书籍 (PRD §5.2「完成后把所有预置书籍加入用户书架」/ §19.1「预置书籍只加入一次」):
// bind every shared book flagged `is_preset` to the user's shelf. The `is_preset` column is the
// config source of truth, so which books are preset is data, not a hardcoded id list here.
//
// Idempotent by design:
//   * `on conflict (user_id, shared_book_id) do nothing` — a repeat call, or a preset the user
//     already has, is a no-op. Crucially we do NOT resurrect a soft-deleted row: once a user removes
//     a preset book it stays removed, satisfying「只加入一次」(unlike the upload path, which un-deletes).
// Returns the number of preset books newly added to the shelf (0 on a replay).
export async function bindPresetBooks(tx: Tx, userId: string): Promise<number> {
  const presets = await tx
    .select({ id: sharedBooks.id })
    .from(sharedBooks)
    .where(eq(sharedBooks.isPreset, true));
  if (presets.length === 0) return 0;

  const inserted = await tx
    .insert(userBooks)
    .values(presets.map((preset) => ({ userId, sharedBookId: preset.id })))
    .onConflictDoNothing({ target: [userBooks.userId, userBooks.sharedBookId] })
    .returning({ id: userBooks.id });
  return inserted.length;
}
