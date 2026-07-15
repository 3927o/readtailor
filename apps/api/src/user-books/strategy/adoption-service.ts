import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { AdoptTrialRequest, AdoptTrialResponse } from '@readtailor/contracts';
import {
  nodeGenerations,
  strategyDraftVersions,
  strategyVersions,
  trialRevisions,
  trialSegments,
  userBooks,
  type Database,
} from '@readtailor/database';
import type { OwnedUserBook } from '../context/setup-context';
import { UserBookError } from '../errors';

export type AdoptionManifest = {
  nodes: Array<{
    section_id: string;
    segment: number;
    order: number;
    tailoring_eligible: boolean;
  }>;
};

export type StrategyAdoptionServiceOptions<TManifest extends AdoptionManifest> = {
  db: Database;
  userId: string;
  modelConfigId: string;
  formalWindowSize: number;
  getOwnedBook(userBookId: string): Promise<OwnedUserBook>;
  loadManifest(sharedBookId: string): Promise<TManifest>;
  ensureFormalWindow(
    userBookId: string,
    strategyVersionId: string,
    sharedBookId: string,
    focusOrder: number,
  ): Promise<void>;
  enqueuePendingFormalGenerations(userBookId: string): Promise<void>;
};

export function createStrategyAdoptionService<TManifest extends AdoptionManifest>(
  options: StrategyAdoptionServiceOptions<TManifest>,
) {
  const {
    db,
    userId,
    modelConfigId,
    formalWindowSize,
    getOwnedBook,
    loadManifest,
    ensureFormalWindow,
    enqueuePendingFormalGenerations,
  } = options;

  const response = (userBookId: string, strategyVersionId: string): AdoptTrialResponse => ({
    userBookId,
    workflowStatus: 'active_reading',
    strategyVersionId,
  });

  const recoverExistingStrategy = async (
    userBookId: string,
    strategyVersionId: string,
  ): Promise<AdoptTrialResponse> => {
    await enqueuePendingFormalGenerations(userBookId);
    return response(userBookId, strategyVersionId);
  };

  const confirmStrategyAndStartReading = async (
    userBookId: string,
    input: AdoptTrialRequest,
  ): Promise<AdoptTrialResponse> => {
    const owned = await getOwnedBook(userBookId);
    if (
      owned.userBook.workflowStatus === 'active_reading'
      && owned.userBook.currentStrategyVersionId
    ) {
      return recoverExistingStrategy(userBookId, owned.userBook.currentStrategyVersionId);
    }

    const manifest = await loadManifest(owned.sharedBook.id);
    const formalNodes = manifest.nodes
      .filter((node) => node.tailoring_eligible)
      .sort((left, right) => left.order - right.order)
      .slice(0, formalWindowSize);
    if (formalNodes.length === 0) {
      throw new UserBookError('书籍没有可生成的正式阅读节点', 409);
    }

    const result = await db.transaction(async (tx) => {
      const [revision] = await tx
        .select()
        .from(trialRevisions)
        .where(and(
          eq(trialRevisions.id, input.trialRevisionId),
          eq(trialRevisions.userBookId, userBookId),
        ))
        .limit(1)
        .for('update');
      const [book] = await tx
        .select()
        .from(userBooks)
        .where(and(
          eq(userBooks.id, userBookId),
          eq(userBooks.userId, userId),
          isNull(userBooks.deletedAt),
        ))
        .limit(1)
        .for('update');
      if (book?.workflowStatus === 'active_reading' && book.currentStrategyVersionId) {
        const [existing] = await tx
          .select({ id: strategyVersions.id })
          .from(strategyVersions)
          .where(and(
            eq(strategyVersions.id, book.currentStrategyVersionId),
            eq(strategyVersions.userBookId, userBookId),
          ))
          .limit(1);
        if (!existing) throw new UserBookError('正式处理方式不存在', 409);
        return { strategyVersionId: existing.id, created: false as const };
      }
      if (
        !book
        || book.workflowStatus !== 'trial_review'
        || book.currentTrialRevisionId !== input.trialRevisionId
        || book.currentStrategyDraftVersionId !== input.strategyDraftVersionId
      ) {
        throw new UserBookError('试读状态已经更新', 409);
      }
      if (
        !revision
        || revision.status !== 'published'
        || revision.strategyDraftVersionId !== input.strategyDraftVersionId
      ) {
        throw new UserBookError('试读版本已经失效', 409);
      }

      const segments = await tx
        .select({ id: trialSegments.id, status: trialSegments.status })
        .from(trialSegments)
        .where(eq(trialSegments.trialRevisionId, revision.id))
        .for('update');
      if (segments.length !== 3 || segments.some((segment) => segment.status !== 'ready')) {
        throw new UserBookError('三个试读片段尚未全部生成', 409);
      }

      const now = new Date();
      const [draft] = await tx
        .update(strategyDraftVersions)
        .set({ status: 'confirmed', confirmedAt: now })
        .where(and(
          eq(strategyDraftVersions.id, input.strategyDraftVersionId),
          eq(strategyDraftVersions.userBookId, userBookId),
          eq(strategyDraftVersions.status, 'approved_for_trial'),
        ))
        .returning();
      if (!draft) throw new UserBookError('处理方式已经更新', 409);

      const [strategy] = await tx
        .insert(strategyVersions)
        .values({
          userBookId,
          sourceDraftVersionId: draft.id,
          version: 1,
          userFacingSummary: draft.userFacingSummary,
          strategy: draft.strategy,
        })
        .returning({ id: strategyVersions.id });
      if (!strategy) throw new Error('failed to create formal strategy');

      await tx.insert(nodeGenerations).values(formalNodes.map((node) => {
        const id = randomUUID();
        return {
          id,
          userBookId,
          generationScope: 'formal' as const,
          strategyVersionId: strategy.id,
          sectionId: node.section_id,
          segment: node.segment,
          status: 'queued' as const,
          modelConfigId,
          promptVersion: 'tailoring-content-1.0',
          cacheKey: `pending:${id}`,
        };
      }));

      const [adopted] = await tx
        .update(trialRevisions)
        .set({ status: 'adopted', adoptedAt: now, updatedAt: now })
        .where(and(
          eq(trialRevisions.id, revision.id),
          eq(trialRevisions.status, 'published'),
        ))
        .returning({ id: trialRevisions.id });
      if (!adopted) throw new UserBookError('试读版本已经失效', 409);

      const [activated] = await tx
        .update(userBooks)
        .set({
          workflowStatus: 'active_reading',
          currentStrategyVersionId: strategy.id,
          updatedAt: now,
        })
        .where(and(
          eq(userBooks.id, userBookId),
          eq(userBooks.workflowStatus, 'trial_review'),
          eq(userBooks.currentTrialRevisionId, revision.id),
          eq(userBooks.currentStrategyDraftVersionId, draft.id),
        ))
        .returning({ id: userBooks.id });
      if (!activated) throw new UserBookError('试读状态已经更新', 409);

      return { strategyVersionId: strategy.id, created: true as const };
    });

    if (!result.created) {
      return recoverExistingStrategy(userBookId, result.strategyVersionId);
    }

    try {
      await ensureFormalWindow(
        userBookId,
        result.strategyVersionId,
        owned.sharedBook.id,
        formalNodes[0]?.order ?? 1,
      );
    } catch {
      await enqueuePendingFormalGenerations(userBookId);
    }
    return response(userBookId, result.strategyVersionId);
  };

  return { confirmStrategyAndStartReading };
}
