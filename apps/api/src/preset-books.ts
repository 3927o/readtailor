import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  bookReaderProfileVersions,
  bookPackages,
  interviewSessions,
  nodeGenerations,
  sharedBooks,
  strategyDraftVersions,
  strategyVersions,
  trialRevisions,
  trialSegments,
  userBooks,
  users,
  type Database,
} from '@readtailor/database';
import {
  getPresetBookTemplate,
  type PresetBookTemplate,
} from './preset-book-templates';

// A transaction handle from `db.transaction`. Preset binding always runs inside the onboarding
// transaction so completing the profile and stocking the shelf commit atomically (PRD §5.2 / §19.1).
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

// §预置书籍 (PRD §5.2「完成后把所有预置书籍加入用户书架」/ §19.1「预置书籍只加入一次」):
// Bind every ready shared book flagged `is_preset` to the user's shelf. The `is_preset` column is
// the catalog source of truth; an optional content template is selected by immutable EPUB/package
// identity after the new user_book row is created.
//
// Idempotent by design:
//   * `on conflict (user_id, shared_book_id) do nothing` — a repeat call, or a preset the user
//     already has, is a no-op. Crucially we do NOT resurrect a soft-deleted row: once a user removes
//     a preset book it stays removed, satisfying「只加入一次」(unlike the upload path, which un-deletes).
export async function hydratePresetUserBook(
  tx: Tx,
  userBookId: string,
  template: PresetBookTemplate,
  now = new Date(),
): Promise<void> {
  const [interview] = await tx
    .insert(interviewSessions)
    .values({
      userBookId,
      status: 'completed',
      questionCount: 0,
      conversationVersion: 0,
      completedAt: now,
      updatedAt: now,
    })
    .returning({ id: interviewSessions.id });
  if (!interview) throw new Error(`failed to create preset interview for ${userBookId}`);

  const [profile] = await tx
    .insert(bookReaderProfileVersions)
    .values({
      userBookId,
      interviewSessionId: interview.id,
      version: 1,
      profile: template.profile,
    })
    .returning({ id: bookReaderProfileVersions.id });
  if (!profile) throw new Error(`failed to create preset reader profile for ${userBookId}`);

  const [draft] = await tx
    .insert(strategyDraftVersions)
    .values({
      userBookId,
      bookReaderProfileVersionId: profile.id,
      version: 1,
      status: 'confirmed',
      readingBriefing: template.readingBriefing,
      userFacingSummary: template.userFacingSummary,
      strategy: template.strategy,
      confirmedAt: now,
    })
    .returning({ id: strategyDraftVersions.id });
  if (!draft) throw new Error(`failed to create preset strategy draft for ${userBookId}`);

  const [strategy] = await tx
    .insert(strategyVersions)
    .values({
      userBookId,
      sourceDraftVersionId: draft.id,
      version: 1,
      userFacingSummary: template.userFacingSummary,
      strategy: template.strategy,
    })
    .returning({ id: strategyVersions.id });
  if (!strategy) throw new Error(`failed to create preset strategy for ${userBookId}`);

  let trialRevisionId: string | null = null;
  if (template.trial) {
    const [revision] = await tx
      .insert(trialRevisions)
      .values({
        userBookId,
        strategyDraftVersionId: draft.id,
        revision: 1,
        status: 'adopted',
        publishedAt: now,
        adoptedAt: now,
        updatedAt: now,
      })
      .returning({ id: trialRevisions.id });
    if (!revision) throw new Error(`failed to create preset trial revision for ${userBookId}`);
    trialRevisionId = revision.id;

    const insertedSegments = await tx
      .insert(trialSegments)
      .values(
        template.trial.segments.map((segment) => ({
          trialRevisionId: revision.id,
          ordinal: segment.ordinal,
          sectionId: segment.sectionId,
          segment: segment.segment,
          startBlockIndex: segment.startBlockIndex,
          startOffset: segment.startOffset,
          endBlockIndex: segment.endBlockIndex,
          endOffset: segment.endOffset,
          selectionReason: segment.selectionReason,
          status: 'ready' as const,
          updatedAt: now,
        })),
      )
      .returning({ id: trialSegments.id, ordinal: trialSegments.ordinal });
    const segmentIdByOrdinal = new Map(
      insertedSegments.map((segment) => [segment.ordinal, segment.id]),
    );
    if (segmentIdByOrdinal.size !== template.trial.segments.length) {
      throw new Error(`failed to create every preset trial segment for ${userBookId}`);
    }

    await tx.insert(nodeGenerations).values(
      template.trial.segments.map((segment) => ({
        userBookId,
        generationScope: 'trial' as const,
        trialSegmentId: segmentIdByOrdinal.get(segment.ordinal)!,
        strategyDraftVersionId: draft.id,
        sectionId: segment.sectionId,
        segment: segment.segment,
        status: 'ready' as const,
        attemptCount: segment.generation.attemptCount,
        maxAttempts: segment.generation.maxAttempts,
        result: segment.generation.result,
        modelConfigId: segment.generation.modelConfigId,
        promptVersion: segment.generation.promptVersion,
        cacheKey: `preset:${template.key}:${userBookId}:trial:${segment.ordinal}`,
        completedAt: now,
        updatedAt: now,
      })),
    );
  }

  await tx.insert(nodeGenerations).values(
    template.formalGenerations.map((generation) => ({
      userBookId,
      generationScope: 'formal' as const,
      strategyVersionId: strategy.id,
      sectionId: generation.sectionId,
      segment: generation.segment,
      status: 'ready' as const,
      attemptCount: generation.attemptCount,
      maxAttempts: generation.maxAttempts,
      result: generation.result,
      modelConfigId: generation.modelConfigId,
      promptVersion: generation.promptVersion,
      cacheKey: `preset:${template.key}:${userBookId}:formal:${generation.sectionId}:${generation.segment}`,
      completedAt: now,
      updatedAt: now,
    })),
  );

  await tx
    .update(userBooks)
    .set({
      workflowStatus: 'active_reading',
      currentInterviewSessionId: interview.id,
      currentBookReaderProfileVersionId: profile.id,
      currentStrategyDraftVersionId: draft.id,
      currentStrategyVersionId: strategy.id,
      currentTrialRevisionId: trialRevisionId,
      updatedAt: now,
    })
    .where(eq(userBooks.id, userBookId));
}

// Returns the number of preset books newly added to the shelf (0 on a replay).
export async function bindPresetBooks(tx: Tx, userId: string): Promise<number> {
  const presets = await tx
    .select({
      id: sharedBooks.id,
      title: sharedBooks.title,
      epubSha256: sharedBooks.epubSha256,
      packageVersion: bookPackages.version,
      manifestVersion: bookPackages.manifestVersion,
      fileHashes: bookPackages.fileHashes,
    })
    .from(sharedBooks)
    .innerJoin(bookPackages, eq(bookPackages.id, sharedBooks.currentPackageId))
    .where(and(eq(sharedBooks.isPreset, true), eq(sharedBooks.status, 'ready')));
  if (presets.length === 0) return 0;

  const inserted = await tx
    .insert(userBooks)
    .values(presets.map((preset) => ({ userId, sharedBookId: preset.id })))
    .onConflictDoNothing({ target: [userBooks.userId, userBooks.sharedBookId] })
    .returning({ id: userBooks.id, sharedBookId: userBooks.sharedBookId });

  const presetById = new Map(presets.map((preset) => [preset.id, preset]));
  for (const userBook of inserted) {
    const preset = presetById.get(userBook.sharedBookId);
    if (!preset) throw new Error(`inserted preset book not found: ${userBook.sharedBookId}`);
    const readingManifestSha256 = preset.fileHashes['reading_manifest.json'];
    const template = getPresetBookTemplate({
      title: preset.title,
      epubSha256: preset.epubSha256,
      packageVersion: preset.packageVersion,
      manifestVersion: preset.manifestVersion,
      readingManifestSha256: readingManifestSha256 ?? '',
    });
    if (template) await hydratePresetUserBook(tx, userBook.id, template);
  }
  return inserted.length;
}

export type PresetBookBackfillResult = {
  eligibleUsers: number;
  changedUsers: number;
  addedBooks: number;
  failures: Array<{ userId: string; error: string }>;
};

export async function backfillPresetBooks(
  database: Database,
  options: { userId?: string } = {},
): Promise<PresetBookBackfillResult> {
  const eligibility = and(
    isNotNull(users.readerProfileCompletedAt),
    isNull(users.disabledAt),
    options.userId ? eq(users.id, options.userId) : undefined,
  );
  const eligibleUsers = await database
    .select({ id: users.id })
    .from(users)
    .where(eligibility)
    .orderBy(users.createdAt, users.id);

  let changedUsers = 0;
  let addedBooks = 0;
  const failures: PresetBookBackfillResult['failures'] = [];
  for (const user of eligibleUsers) {
    try {
      const added = await database.transaction((tx) => bindPresetBooks(tx, user.id));
      addedBooks += added;
      if (added > 0) changedUsers += 1;
    } catch (error) {
      failures.push({
        userId: user.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    eligibleUsers: eligibleUsers.length,
    changedUsers,
    addedBooks,
    failures,
  };
}
