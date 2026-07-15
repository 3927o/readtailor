import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  ApproveStrategyRequest,
  MarkTrialSegmentViewedRequest,
  ProvisionalTrialSample,
  ReadingSetupStreamErrorCode,
  StrategyReviewResponse,
  TextRange,
  TrialCandidate,
  TrialReviewResponse,
  TrialSelectionStreamEvent,
} from '@readtailor/contracts';
import type {
  ReadingSetupStreamDelta,
  TrialFragmentSelection,
} from '@readtailor/agent-kit';
import {
  nodeGenerations,
  readingSetupOperations,
  strategyDraftVersions,
  trialRevisions,
  trialSegments,
  userBooks,
  type Database,
} from '@readtailor/database';
import { extractNodeSourceFromHtml, sliceNodeSource } from '@readtailor/tailoring';
import type { BookService } from '../../books';
import type { ReadingSetupEngine } from '../../reading-setup-engine';
import type { OwnedUserBook } from '../context/setup-context';
import { ADJUSTMENT_LIMIT } from '../domain/reading-setup-state';
import { UserBookError } from '../errors';
import {
  ReadingSetupLeaseLostError,
  type createSetupOperationStore,
  type PreparedReadingSetupOperation,
  type ReadingSetupOperationClaim,
  type ReadingSetupOperationRow,
} from '../operations/setup-operation-store';
import { projectTrialReview, projectTrialSegment } from '../projections/trial-review';
import { buildTrialRetryPlan, resolveTrialFragmentRanges } from './domain';

export type TrialManifestNode = {
  section_id: string;
  segment: number;
  title?: string;
  tailoring_eligible: boolean;
};

export type TrialManifest = {
  nodes: TrialManifestNode[];
  outline: Array<{
    section_id: string;
    title: string;
    parent_section_id: string | null;
  }>;
};

type TrialFragmentStreamValue = Extract<ReadingSetupStreamDelta, { type: 'fragment_added' }>['fragment'];

type TrialSelectionTurnStreamDelta =
  | Extract<ReadingSetupStreamDelta, { type: 'speculative_reset' | 'selection_started' }>
  | {
      type: 'fragment_selected';
      speculativeEpoch: number;
      sample: ProvisionalTrialSample;
    };

type TrialSelectionStreamPayload = TrialSelectionStreamEvent extends infer Event
  ? Event extends TrialSelectionStreamEvent
    ? Omit<Event, 'userBookId' | 'operationId' | 'operationAttempt' | 'sequence'>
    : never
  : never;

type SetupContext = {
  owned: OwnedUserBook;
  context: Record<string, unknown> & { bookProfile: unknown };
};

type OperationStore = Pick<
  ReturnType<typeof createSetupOperationStore>,
  | 'resolve'
  | 'observeById'
  | 'prepareExecution'
  | 'startLeaseRenewal'
  | 'fail'
>;

type GenerationEnqueuer = {
  enqueue(input: {
    generationId: string;
    userBookId: string;
    scope: 'trial' | 'formal';
    priority?: number;
  }): Promise<void>;
};

export type TrialServiceOptions<TManifest extends TrialManifest> = {
  db: Database;
  books: BookService;
  setupEngine: ReadingSetupEngine;
  generations: GenerationEnqueuer;
  operationStore: OperationStore;
  userId: string;
  modelConfigId: string;
  requestId?: string;
  getOwnedBook(userBookId: string): Promise<OwnedUserBook>;
  getSetupContext(userBookId: string): Promise<SetupContext>;
  parseManifest(value: unknown): TManifest;
  chapterPath(node: TManifest['nodes'][number], outline: TManifest['outline']): string[];
  assertRangeWithinBlocks(
    blocks: Array<{ block_index: number; text: string }>,
    range: TextRange,
    label?: string,
  ): void;
  loadStrategyState(userBookId: string, draftId: string): Promise<StrategyReviewResponse>;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createStreamBridge<T>() {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const signal = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  return {
    push(item: T) {
      queue.push(item);
      signal();
    },
    end() {
      ended = true;
      signal();
    },
    async *drain(): AsyncGenerator<T> {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

export function createTrialService<TManifest extends TrialManifest>(
  options: TrialServiceOptions<TManifest>,
) {
  const {
    db,
    books,
    setupEngine,
    generations,
    operationStore,
    userId,
    modelConfigId,
    requestId,
    getOwnedBook,
    getSetupContext,
    parseManifest,
    chapterPath,
    assertRangeWithinBlocks,
    loadStrategyState,
  } = options;

  const getManifestAndHtml = async (sharedBookId: string) => {
    const [manifestValue, content] = await Promise.all([
      books.getManifest(sharedBookId),
      books.getContent(sharedBookId),
    ]);
    if (!manifestValue || !content) {
      throw new UserBookError('书籍原文或阅读索引不存在', 409);
    }
    return {
      manifest: parseManifest(manifestValue),
      html: new TextDecoder().decode(content),
    };
  };

  const enqueueTrialRevisionGenerations = async (
    userBookId: string,
    trialRevisionId: string,
    generationIds: string[],
  ) => {
    try {
      await Promise.all(generationIds.map((generationId) => generations.enqueue({
        generationId,
        userBookId,
        scope: 'trial',
      })));
    } catch {
      await db.transaction(async (tx) => {
        const [book] = await tx
          .select()
          .from(userBooks)
          .where(eq(userBooks.id, userBookId))
          .limit(1)
          .for('update');
        const [revision] = await tx
          .select()
          .from(trialRevisions)
          .where(and(
            eq(trialRevisions.id, trialRevisionId),
            eq(trialRevisions.userBookId, userBookId),
          ))
          .limit(1)
          .for('update');
        const draft = revision
          ? await tx
              .select({ id: strategyDraftVersions.id, status: strategyDraftVersions.status })
              .from(strategyDraftVersions)
              .where(eq(strategyDraftVersions.id, revision.strategyDraftVersionId))
              .limit(1)
              .for('update')
              .then((rows) => rows[0])
          : undefined;
        const segments = revision
          ? await tx
              .select({ id: trialSegments.id })
              .from(trialSegments)
              .where(eq(trialSegments.trialRevisionId, revision.id))
              .orderBy(asc(trialSegments.ordinal))
              .for('update')
          : [];
        await tx
          .select({ id: nodeGenerations.id })
          .from(nodeGenerations)
          .where(inArray(nodeGenerations.id, generationIds))
          .for('update');
        if (
          !book
          || !revision
          || !draft
          || draft.status !== 'approved_for_trial'
          || revision.status !== 'generating'
          || revision.strategyDraftVersionId !== draft.id
          || book.workflowStatus !== 'trial_generating'
          || book.currentStrategyDraftVersionId !== draft.id
          || book.currentTrialRevisionId !== revision.id
          || segments.length !== 3
        ) return;
        const now = new Date();
        const failedGenerations = await tx
          .update(nodeGenerations)
          .set({
            status: 'failed',
            result: null,
            errorSummary: '内容生成任务入队失败',
            completedAt: now,
            updatedAt: now,
          })
          .where(and(
            inArray(nodeGenerations.id, generationIds),
            inArray(nodeGenerations.status, ['queued', 'generating', 'retrying']),
          ))
          .returning({ trialSegmentId: nodeGenerations.trialSegmentId });
        const failedSegmentIds = failedGenerations
          .map((generation) => generation.trialSegmentId)
          .filter((segmentId): segmentId is string => Boolean(segmentId));
        if (failedSegmentIds.length > 0) {
          await tx
            .update(trialSegments)
            .set({ status: 'failed', updatedAt: now })
            .where(and(
              inArray(trialSegments.id, failedSegmentIds),
              inArray(trialSegments.status, ['pending', 'generating']),
            ));
        }
        const [failedRevision] = await tx
          .update(trialRevisions)
          .set({
            status: 'failed',
            failureSummary: '试读内容暂时无法开始生成，请重试。',
            failedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(trialRevisions.id, trialRevisionId),
            eq(trialRevisions.status, 'generating'),
          ))
          .returning({ id: trialRevisions.id });
        if (!failedRevision) return;
        await tx
          .update(userBooks)
          .set({ workflowStatus: 'trial_generation_failed', updatedAt: now })
          .where(and(
            eq(userBooks.id, userBookId),
            eq(userBooks.workflowStatus, 'trial_generating'),
            eq(userBooks.currentTrialRevisionId, trialRevisionId),
            eq(userBooks.currentStrategyDraftVersionId, draft.id),
          ));
      }).catch(() => {});
    }
  };

  const approveDraftForTrial = async (
    userBookId: string,
    draftId: string,
    fragments: TrialCandidate[],
    operationClaim: ReadingSetupOperationClaim,
  ) => {
    const owned = await getOwnedBook(userBookId);
    const [draft] = await db
      .select()
      .from(strategyDraftVersions)
      .where(and(
        eq(strategyDraftVersions.id, draftId),
        eq(strategyDraftVersions.userBookId, userBookId),
      ))
      .limit(1);
    if (!draft) throw new UserBookError('策略草稿不存在', 404);
    const [{ manifest, html }, bookProfileValue] = await Promise.all([
      getManifestAndHtml(owned.sharedBook.id),
      books.getProfile(owned.sharedBook.id),
    ]);
    const allowedCandidates = new Set(
      ((bookProfileValue as { trial_candidates?: Array<{ section_id: string; segment: number }> } | null)
        ?.trial_candidates ?? [])
        .map((candidate) => `${candidate.section_id}:${candidate.segment}`),
    );
    const tags = new Set(fragments.map((fragment) => fragment.tag));
    if (
      fragments.length !== 3
      || tags.size !== 3
      || !tags.has('threshold')
      || !tags.has('typical')
      || !tags.has('hardest')
    ) {
      throw new UserBookError('试读片段选择结果不完整', 409);
    }
    const selected = fragments.map((candidate) => {
      const node = manifest.nodes.find(
        (item) => item.section_id === candidate.sectionId && item.segment === candidate.segment,
      );
      if (!node?.tailoring_eligible) {
        throw new UserBookError('策略草稿引用了不可裁读的试读候选', 409);
      }
      if (!allowedCandidates.has(`${candidate.sectionId}:${candidate.segment}`)) {
        throw new UserBookError('策略草稿引用了书籍画像候选池之外的试读位置', 409);
      }
      if (!candidate.range) throw new UserBookError('试读片段缺少范围', 409);
      const source = extractNodeSourceFromHtml(html, candidate.sectionId, candidate.segment);
      assertRangeWithinBlocks(source.blocks, candidate.range);
      const ordinal = candidate.tag === 'threshold'
        ? 1
        : candidate.tag === 'typical'
          ? 2
          : 3;
      return { candidate, node, ordinal, range: candidate.range };
    });
    if (new Set(selected.map((item) => `${item.node.section_id}:${item.node.segment}`)).size !== 3) {
      throw new UserBookError('三个试读片段必须互不重叠', 409);
    }

    const created = await db.transaction(async (tx) => {
      const changed = await tx
        .update(strategyDraftVersions)
        .set({
          status: 'approved_for_trial',
          approvedForTrialAt: new Date(),
          strategy: { ...draft.strategy, trialCandidates: fragments },
        })
        .where(and(
          eq(strategyDraftVersions.id, draftId),
          eq(strategyDraftVersions.userBookId, userBookId),
          eq(strategyDraftVersions.status, 'draft'),
        ))
        .returning({ id: strategyDraftVersions.id });
      if (changed.length !== 1) throw new UserBookError('处理方式已经确认或更新', 409);
      const [lastRevision] = await tx
        .select({ revision: trialRevisions.revision })
        .from(trialRevisions)
        .where(eq(trialRevisions.userBookId, userBookId))
        .orderBy(desc(trialRevisions.revision))
        .limit(1);
      const [revision] = await tx
        .insert(trialRevisions)
        .values({
          userBookId,
          strategyDraftVersionId: draftId,
          revision: (lastRevision?.revision ?? 0) + 1,
          status: 'generating',
        })
        .returning();
      if (!revision) throw new Error('failed to create trial revision');
      const generationIds: string[] = [];
      for (const item of selected) {
        const [segment] = await tx
          .insert(trialSegments)
          .values({
            trialRevisionId: revision.id,
            ordinal: item.ordinal,
            sectionId: item.node.section_id,
            segment: item.node.segment,
            startBlockIndex: item.range.start.blockIndex,
            startOffset: item.range.start.offset,
            endBlockIndex: item.range.end.blockIndex,
            endOffset: item.range.end.offset,
            selectionReason: item.candidate.reason,
            status: 'pending',
          })
          .returning();
        if (!segment) throw new Error('failed to create trial segment');
        const generationId = randomUUID();
        await tx.insert(nodeGenerations).values({
          id: generationId,
          userBookId,
          generationScope: 'trial',
          trialSegmentId: segment.id,
          strategyDraftVersionId: draftId,
          sectionId: item.node.section_id,
          segment: item.node.segment,
          status: 'queued',
          modelConfigId,
          promptVersion: 'tailoring-content-1.0',
          cacheKey: `pending:${generationId}`,
        });
        generationIds.push(generationId);
      }
      const advanced = await tx
        .update(userBooks)
        .set({
          workflowStatus: 'trial_generating',
          currentTrialRevisionId: revision.id,
          updatedAt: new Date(),
        })
        .where(and(
          eq(userBooks.id, userBookId),
          eq(userBooks.currentStrategyDraftVersionId, draftId),
          eq(userBooks.workflowStatus, 'strategy_review'),
        ))
        .returning({ id: userBooks.id });
      if (advanced.length !== 1) {
        throw new UserBookError('处理方式已经更新，请刷新后继续', 409);
      }
      const completed = await tx
        .update(readingSetupOperations)
        .set({
          status: 'completed',
          leaseId: null,
          leaseClaimedAt: null,
          leaseExpiresAt: null,
          resultStrategyDraftVersionId: null,
          resultTrialRevisionId: revision.id,
          errorSummary: null,
          completedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(readingSetupOperations.id, operationClaim.operationId),
          eq(readingSetupOperations.status, 'running'),
          eq(readingSetupOperations.leaseId, operationClaim.leaseId),
          eq(readingSetupOperations.attemptCount, operationClaim.attemptCount),
          sql`${readingSetupOperations.leaseExpiresAt} > now()`,
          eq(readingSetupOperations.baseStrategyDraftVersionId, draftId),
          isNull(readingSetupOperations.baseTrialRevisionId),
        ))
        .returning({ id: readingSetupOperations.id });
      if (completed.length !== 1) throw new ReadingSetupLeaseLostError();
      return { revision, generationIds };
    });
    await enqueueTrialRevisionGenerations(userBookId, created.revision.id, created.generationIds);
    return created.revision;
  };

  const selectTrialFragments = async (
    userBookId: string,
    draft: StrategyReviewResponse['draft'],
    optionsForRun: {
      assertLeaseActive(): void;
      onStream?: (delta: TrialSelectionTurnStreamDelta) => void;
    },
  ): Promise<TrialCandidate[]> => {
    const setup = await getSetupContext(userBookId);
    const { manifest, html } = await getManifestAndHtml(setup.owned.sharedBook.id);
    const candidateKeys = new Set(
      draft.strategy.trialCandidates.map((candidate) => `${candidate.sectionId}:${candidate.segment}`),
    );
    if (candidateKeys.size !== 3) {
      throw new UserBookError('处理方式中的试读候选不完整', 409);
    }
    const projectFragment = (
      fragment: TrialFragmentStreamValue,
      seenTags: Set<TrialFragmentStreamValue['tag']>,
      seenNodes: Set<string>,
    ): ProvisionalTrialSample => {
      const ordinal = fragment.tag === 'threshold' ? 1 : fragment.tag === 'typical' ? 2 : 3;
      const key = `${fragment.section_id}:${fragment.segment}`;
      const node = manifest.nodes.find(
        (item) => item.section_id === fragment.section_id && item.segment === fragment.segment,
      );
      if (
        !candidateKeys.has(key)
        || !node?.tailoring_eligible
        || seenTags.has(fragment.tag)
        || seenNodes.has(key)
      ) {
        throw new UserBookError('试读片段选择不符合当前候选位置', 409);
      }
      const source = extractNodeSourceFromHtml(html, fragment.section_id, fragment.segment);
      const resolved = resolveTrialFragmentRanges([fragment], [{
        section_id: fragment.section_id,
        segment: fragment.segment,
        blocks: source.blocks.map((block) => ({ block_index: block.block_index, text: block.text })),
      }])[0]!;
      const range = resolved.range;
      if (!range) throw new UserBookError('试读片段范围结果损坏', 409);
      assertRangeWithinBlocks(source.blocks, range);
      const sliced = sliceNodeSource(source, {
        start: { block_index: range.start.blockIndex, offset: range.start.offset },
        end: { block_index: range.end.blockIndex, offset: range.end.offset },
      });
      seenTags.add(fragment.tag);
      seenNodes.add(key);
      return {
        ordinal,
        tag: fragment.tag,
        sectionId: fragment.section_id,
        segment: fragment.segment,
        range,
        chapterPath: chapterPath(node, manifest.outline),
        originalHtml: sliced.structuredHtml,
        selectionReason: fragment.reason,
      } as ProvisionalTrialSample;
    };
    const trialNodeContents = draft.strategy.trialCandidates.map((candidate) => {
      const node = manifest.nodes.find(
        (item) => item.section_id === candidate.sectionId && item.segment === candidate.segment,
      );
      const source = extractNodeSourceFromHtml(html, candidate.sectionId, candidate.segment);
      return {
        section_id: candidate.sectionId,
        segment: candidate.segment,
        title: node?.title ?? '',
        tailoring_eligible: node?.tailoring_eligible ?? false,
        blocks: source.blocks.map((block) => ({ block_index: block.block_index, text: block.text })),
      };
    });
    let streamedEpoch = 0;
    let streamedTags = new Set<TrialFragmentStreamValue['tag']>();
    let streamedNodes = new Set<string>();
    const outcome = await setupEngine.runTurn({
      sessionId: setup.owned.userBook.currentInterviewSessionId!,
      phase: 'select_trial',
      askedCount: 0,
      context: { ...setup.context, currentStrategy: draft, trialNodeContents },
      ...(requestId ? { requestId } : {}),
      ...(optionsForRun.onStream ? {
        onStream: (delta: ReadingSetupStreamDelta) => {
          optionsForRun.assertLeaseActive();
          if (delta.type === 'speculative_reset') {
            streamedEpoch = delta.speculativeEpoch;
            streamedTags = new Set<TrialFragmentStreamValue['tag']>();
            streamedNodes = new Set<string>();
            optionsForRun.onStream?.(delta);
            return;
          }
          if (delta.speculativeEpoch < streamedEpoch) return;
          if (delta.speculativeEpoch > streamedEpoch) {
            streamedEpoch = delta.speculativeEpoch;
            streamedTags = new Set<TrialFragmentStreamValue['tag']>();
            streamedNodes = new Set<string>();
          }
          if (delta.type === 'selection_started') {
            optionsForRun.onStream?.(delta);
          } else if (delta.type === 'fragment_added') {
            try {
              optionsForRun.onStream?.({
                type: 'fragment_selected',
                speculativeEpoch: delta.speculativeEpoch,
                sample: projectFragment(delta.fragment, streamedTags, streamedNodes),
              });
            } catch (error) {
              if (!(error instanceof UserBookError)) throw error;
            }
          }
        },
      } : {}),
    });
    if (outcome.type !== 'fragments') throw new UserBookError('试读片段选择失败', 503);
    const finalTags = new Set<TrialFragmentStreamValue['tag']>();
    const finalNodes = new Set<string>();
    const selected = outcome.fragments
      .map((fragment) => projectFragment(fragment, finalTags, finalNodes))
      .sort((left, right) => left.ordinal - right.ordinal);
    if (selected.length !== 3 || finalTags.size !== 3 || finalNodes.size !== 3) {
      throw new UserBookError('试读片段选择结果不完整', 409);
    }
    optionsForRun.assertLeaseActive();
    return selected.map((sample) => ({
      sectionId: sample.sectionId,
      segment: sample.segment,
      reason: sample.selectionReason,
      tag: sample.tag,
      range: sample.range,
    }));
  };

  const stateByRevisionId = async (
    userBookId: string,
    revisionId: string,
  ): Promise<TrialReviewResponse> => {
    const owned = await getOwnedBook(userBookId);
    const [revision, segmentRows, source] = await Promise.all([
      db
        .select()
        .from(trialRevisions)
        .where(and(
          eq(trialRevisions.id, revisionId),
          eq(trialRevisions.userBookId, userBookId),
        ))
        .limit(1)
        .then((rows) => rows[0]),
      db
        .select({ segment: trialSegments, generation: nodeGenerations })
        .from(trialSegments)
        .leftJoin(nodeGenerations, eq(nodeGenerations.trialSegmentId, trialSegments.id))
        .where(eq(trialSegments.trialRevisionId, revisionId))
        .orderBy(asc(trialSegments.ordinal)),
      getManifestAndHtml(owned.sharedBook.id),
    ]);
    if (!revision) throw new UserBookError('试读版本不存在', 404);
    const segments = segmentRows.map(({ segment, generation }) => {
      const extracted = extractNodeSourceFromHtml(source.html, segment.sectionId, segment.segment);
      const sliced = sliceNodeSource(extracted, {
        start: { block_index: segment.startBlockIndex, offset: segment.startOffset },
        end: { block_index: segment.endBlockIndex, offset: segment.endOffset },
      });
      const node = source.manifest.nodes.find(
        (item) => item.section_id === segment.sectionId && item.segment === segment.segment,
      )!;
      return projectTrialSegment({
        id: segment.id,
        ordinal: segment.ordinal,
        sectionId: segment.sectionId,
        segment: segment.segment,
        startBlockIndex: segment.startBlockIndex,
        startOffset: segment.startOffset,
        endBlockIndex: segment.endBlockIndex,
        endOffset: segment.endOffset,
        chapterPath: chapterPath(node, source.manifest.outline),
        originalHtml: sliced.structuredHtml,
        selectionReason: segment.selectionReason,
        viewedAt: segment.viewedAt,
        segmentStatus: segment.status,
        generationStatus: generation?.status ?? null,
        generationResult: generation?.result ?? null,
      });
    });
    return projectTrialReview({
      userBookId,
      workflowStatus: owned.userBook.workflowStatus,
      currentTrialRevisionId: owned.userBook.currentTrialRevisionId,
      trialRevisionId: revision.id,
      revision: revision.revision,
      status: revision.status,
      strategyDraftVersionId: revision.strategyDraftVersionId,
      segments,
      adjustmentCount: owned.userBook.adjustmentCount,
      adjustmentLimit: ADJUSTMENT_LIMIT,
    });
  };

  const state = async (userBookId: string): Promise<TrialReviewResponse> => {
    const owned = await getOwnedBook(userBookId);
    const revisionId = owned.userBook.currentTrialRevisionId;
    if (!revisionId) throw new UserBookError('当前试读不存在', 409);
    return stateByRevisionId(userBookId, revisionId);
  };

  const resolveApproveOperation = async (
    userBookId: string,
    input: ApproveStrategyRequest,
  ) => {
    const strategyDraftVersionId = input.strategyDraftVersionId.toLowerCase();
    const idempotencyKey = input.idempotencyKey.trim();
    if (!UUID_RE.test(strategyDraftVersionId) || !idempotencyKey) {
      throw new UserBookError('处理方式确认请求无效', 400);
    }
    return operationStore.resolve(userBookId, {
      kind: 'trial_selection',
      source: 'strategy_approve',
      baseStrategyDraftVersionId: strategyDraftVersionId,
      baseTrialRevisionId: null,
      idempotencyKey,
      payload: { source: 'strategy_approve', strategyDraftVersionId },
    });
  };

  const runPreparedOperation = async (
    prepared: PreparedReadingSetupOperation,
    onStream?: (delta: TrialSelectionTurnStreamDelta) => void,
  ): Promise<string> => {
    const operation = prepared.operation;
    if (operation.kind !== 'trial_selection' || operation.payload.source !== 'strategy_approve') {
      throw new UserBookError('阅读准备操作类型不匹配', 409);
    }
    if (operation.status === 'completed') {
      if (!operation.resultTrialRevisionId) {
        throw new UserBookError('阅读准备操作结果损坏', 409);
      }
      return operation.resultTrialRevisionId;
    }
    if (!prepared.claim) {
      throw new UserBookError(operation.errorSummary ?? '阅读准备操作失败', 503);
    }
    const claim = prepared.claim;
    const lease = operationStore.startLeaseRenewal(claim);
    try {
      const current = await loadStrategyState(
        operation.userBookId,
        operation.baseStrategyDraftVersionId,
      );
      lease.assertActive();
      const fragments = await selectTrialFragments(operation.userBookId, current.draft, {
        assertLeaseActive: () => lease.assertActive(),
        ...(onStream ? { onStream } : {}),
      });
      lease.assertActive();
      const revision = await approveDraftForTrial(
        operation.userBookId,
        current.draft.id,
        fragments,
        claim,
      );
      return revision.id;
    } catch (error) {
      if (!(error instanceof ReadingSetupLeaseLostError)) {
        const failed = await operationStore.fail(claim, error).catch(() => false);
        if (!failed) throw new ReadingSetupLeaseLostError();
      }
      throw error;
    } finally {
      lease.stop();
    }
  };

  const executeOperation = async (initialOperation: ReadingSetupOperationRow): Promise<void> => {
    const prepared = await operationStore.prepareExecution(initialOperation);
    try {
      await runPreparedOperation(prepared);
    } catch (error) {
      if (error instanceof ReadingSetupLeaseLostError) {
        throw new UserBookError('阅读准备操作已由新请求接管，请查询恢复状态', 409);
      }
      throw error;
    }
  };

  const createStreamEmitter = (
    operation: ReadingSetupOperationRow,
    operationAttempt: number,
  ) => {
    let sequence = 0;
    return (payload: TrialSelectionStreamPayload): TrialSelectionStreamEvent => ({
      userBookId: operation.userBookId,
      operationId: operation.id,
      operationAttempt,
      sequence: sequence += 1,
      ...payload,
    } as TrialSelectionStreamEvent);
  };

  const streamOperation = async function* (
    initialOperation: ReadingSetupOperationRow,
  ): AsyncGenerator<TrialSelectionStreamEvent> {
    if (initialOperation.status === 'running') {
      const observed = await operationStore.observeById(
        initialOperation.userBookId,
        initialOperation.id,
      );
      if (observed && !observed.leaseExpired) {
        throw new UserBookError('阅读准备操作仍在处理中，请查询恢复状态', 409);
      }
    }
    const prepared = await operationStore.prepareExecution(initialOperation, false);
    const operation = prepared.operation;
    if (operation.kind !== 'trial_selection' || operation.payload.source !== 'strategy_approve') {
      throw new UserBookError('阅读准备操作类型不匹配', 409);
    }
    const operationAttempt = prepared.claim?.attemptCount ?? operation.attemptCount;
    if (operationAttempt < 1) throw new UserBookError('阅读准备操作尚未开始', 409);
    const emit = createStreamEmitter(operation, operationAttempt);
    const bridge = createStreamBridge<TrialSelectionStreamEvent>();
    let resultTrialRevisionId: string | undefined;
    let operationError: unknown;
    const running = runPreparedOperation(prepared, (delta) => {
      switch (delta.type) {
        case 'speculative_reset':
          bridge.push(emit({
            type: 'speculative_reset',
            speculativeEpoch: delta.speculativeEpoch,
            phase: 'select_trial',
          }));
          break;
        case 'selection_started':
          bridge.push(emit({
            type: 'selection_started',
            speculativeEpoch: delta.speculativeEpoch,
            draftId: operation.baseStrategyDraftVersionId,
            slots: [
              { ordinal: 1, tag: 'threshold' },
              { ordinal: 2, tag: 'typical' },
              { ordinal: 3, tag: 'hardest' },
            ],
          }));
          break;
        case 'fragment_selected':
          bridge.push(emit({
            type: 'fragment_selected',
            speculativeEpoch: delta.speculativeEpoch,
            draftId: operation.baseStrategyDraftVersionId,
            sample: delta.sample,
          }));
          break;
      }
    })
      .then((value) => {
        resultTrialRevisionId = value;
      })
      .catch((error: unknown) => {
        operationError = error;
      })
      .finally(() => bridge.end());

    for await (const event of bridge.drain()) yield event;
    await running;
    if (operationError) {
      const code: ReadingSetupStreamErrorCode = operationError instanceof ReadingSetupLeaseLostError
        ? 'lease_lost'
        : operationError instanceof UserBookError && operationError.statusCode < 500
          ? 'validation_failed'
          : 'agent_failed';
      yield emit({
        type: 'error',
        code,
        message: operationError instanceof UserBookError
          ? operationError.message
          : code === 'lease_lost'
            ? '阅读准备操作已由新的恢复请求接管。'
            : '试读片段选择失败，请稍后重试。',
      });
      return;
    }
    if (!resultTrialRevisionId) {
      yield emit({ type: 'error', code: 'internal_error', message: '试读片段选择结果缺失。' });
      return;
    }
    try {
      const trial = await stateByRevisionId(operation.userBookId, resultTrialRevisionId);
      yield emit({
        type: 'trial_created',
        draftId: operation.baseStrategyDraftVersionId,
        trial,
      });
    } catch {
      yield emit({
        type: 'error',
        code: 'internal_error',
        message: '试读版本已经创建，正在重新读取最终结果。',
      });
    }
  };

  const streamApprove = async function* (
    userBookId: string,
    input: ApproveStrategyRequest,
  ): AsyncGenerator<TrialSelectionStreamEvent> {
    const operation = await resolveApproveOperation(userBookId, input);
    yield* streamOperation(operation);
  };

  const retry = async (userBookId: string): Promise<TrialReviewResponse> => {
    await getOwnedBook(userBookId);
    const created = await db.transaction(async (tx) => {
      const now = new Date();
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
      if (
        !book
        || book.workflowStatus !== 'trial_generation_failed'
        || !book.currentTrialRevisionId
        || !book.currentStrategyDraftVersionId
      ) {
        throw new UserBookError('当前试读不需要重试', 409);
      }
      const [revision] = await tx
        .select()
        .from(trialRevisions)
        .where(and(
          eq(trialRevisions.id, book.currentTrialRevisionId),
          eq(trialRevisions.userBookId, userBookId),
        ))
        .limit(1)
        .for('update');
      if (
        !revision
        || revision.status !== 'failed'
        || revision.strategyDraftVersionId !== book.currentStrategyDraftVersionId
      ) {
        throw new UserBookError('试读状态已经更新', 409);
      }
      const [draft] = await tx
        .select({ id: strategyDraftVersions.id, status: strategyDraftVersions.status })
        .from(strategyDraftVersions)
        .where(and(
          eq(strategyDraftVersions.id, revision.strategyDraftVersionId),
          eq(strategyDraftVersions.userBookId, userBookId),
        ))
        .limit(1)
        .for('update');
      if (!draft || draft.status !== 'approved_for_trial') {
        throw new UserBookError('试读使用的处理方式已经失效', 409);
      }
      const segments = await tx
        .select()
        .from(trialSegments)
        .where(eq(trialSegments.trialRevisionId, revision.id))
        .orderBy(asc(trialSegments.ordinal))
        .for('update');
      if (segments.length !== 3) {
        throw new UserBookError('失败试读版本的片段数据不完整', 409);
      }
      const existingGenerations = await tx
        .select()
        .from(nodeGenerations)
        .where(and(
          eq(nodeGenerations.userBookId, userBookId),
          eq(nodeGenerations.generationScope, 'trial'),
          inArray(nodeGenerations.trialSegmentId, segments.map((segment) => segment.id)),
        ))
        .for('update');
      const retryPlan = buildTrialRetryPlan(
        revision.strategyDraftVersionId,
        segments,
        existingGenerations,
      );
      const supersededGenerations = await tx
        .update(nodeGenerations)
        .set({ status: 'superseded', result: null, completedAt: now, updatedAt: now })
        .where(and(
          inArray(nodeGenerations.id, retryPlan.map((item) => item.generation.id)),
          eq(nodeGenerations.userBookId, userBookId),
          eq(nodeGenerations.generationScope, 'trial'),
          inArray(nodeGenerations.status, ['queued', 'generating', 'retrying', 'ready', 'failed']),
        ))
        .returning({ id: nodeGenerations.id });
      if (supersededGenerations.length !== 3) {
        throw new UserBookError('试读状态已经更新', 409);
      }
      const [supersededRevision] = await tx
        .update(trialRevisions)
        .set({ status: 'superseded', supersededAt: now, updatedAt: now })
        .where(and(
          eq(trialRevisions.id, revision.id),
          eq(trialRevisions.status, 'failed'),
        ))
        .returning({ id: trialRevisions.id });
      if (!supersededRevision) throw new UserBookError('试读状态已经更新', 409);
      const [lastRevision] = await tx
        .select({ revision: trialRevisions.revision })
        .from(trialRevisions)
        .where(eq(trialRevisions.userBookId, userBookId))
        .orderBy(desc(trialRevisions.revision))
        .limit(1);
      const [newRevision] = await tx
        .insert(trialRevisions)
        .values({
          userBookId,
          strategyDraftVersionId: revision.strategyDraftVersionId,
          revision: (lastRevision?.revision ?? revision.revision) + 1,
          status: 'generating',
        })
        .returning();
      if (!newRevision) throw new Error('failed to create retry trial revision');
      const newSegments = await tx
        .insert(trialSegments)
        .values(retryPlan.map(({ segment }) => ({
          trialRevisionId: newRevision.id,
          ordinal: segment.ordinal,
          sectionId: segment.sectionId,
          segment: segment.segment,
          startBlockIndex: segment.startBlockIndex,
          startOffset: segment.startOffset,
          endBlockIndex: segment.endBlockIndex,
          endOffset: segment.endOffset,
          selectionReason: segment.selectionReason,
          status: 'pending' as const,
        })))
        .returning({ id: trialSegments.id, ordinal: trialSegments.ordinal });
      if (newSegments.length !== 3) throw new Error('failed to copy retry trial segments');
      const newSegmentIdByOrdinal = new Map(
        newSegments.map((segment) => [segment.ordinal, segment.id]),
      );
      const generationRows = retryPlan.map(({ segment, generation }) => {
        const trialSegmentId = newSegmentIdByOrdinal.get(segment.ordinal);
        if (!trialSegmentId) throw new Error('failed to map retry trial segment');
        return {
          id: randomUUID(),
          userBookId,
          generationScope: 'trial' as const,
          trialSegmentId,
          strategyDraftVersionId: revision.strategyDraftVersionId,
          sectionId: segment.sectionId,
          segment: segment.segment,
          status: 'queued' as const,
          maxAttempts: generation.maxAttempts,
          modelConfigId: generation.modelConfigId,
          promptVersion: generation.promptVersion,
        };
      });
      await tx.insert(nodeGenerations).values(generationRows.map((generation) => ({
        ...generation,
        cacheKey: `pending:${generation.id}`,
      })));
      const [advanced] = await tx
        .update(userBooks)
        .set({
          workflowStatus: 'trial_generating',
          currentTrialRevisionId: newRevision.id,
          updatedAt: now,
        })
        .where(and(
          eq(userBooks.id, userBookId),
          eq(userBooks.workflowStatus, 'trial_generation_failed'),
          eq(userBooks.currentTrialRevisionId, revision.id),
          eq(userBooks.currentStrategyDraftVersionId, revision.strategyDraftVersionId),
        ))
        .returning({ id: userBooks.id });
      if (!advanced) throw new UserBookError('试读状态已经更新', 409);
      return {
        revisionId: newRevision.id,
        generationIds: generationRows.map((row) => row.id),
      };
    });
    await enqueueTrialRevisionGenerations(userBookId, created.revisionId, created.generationIds);
    return stateByRevisionId(userBookId, created.revisionId);
  };

  const markViewed = async (
    userBookId: string,
    input: MarkTrialSegmentViewedRequest,
  ): Promise<TrialReviewResponse> => {
    await db.transaction(async (tx) => {
      const [book] = await tx
        .select()
        .from(userBooks)
        .where(eq(userBooks.id, userBookId))
        .limit(1);
      const [revision] = await tx
        .select()
        .from(trialRevisions)
        .where(and(
          eq(trialRevisions.id, input.trialRevisionId),
          eq(trialRevisions.userBookId, userBookId),
        ))
        .limit(1);
      if (
        !book
        || book.workflowStatus !== 'trial_review'
        || book.currentTrialRevisionId !== input.trialRevisionId
        || !revision
        || revision.status !== 'published'
      ) {
        throw new UserBookError('试读版本尚未发布或已经更新', 409);
      }
      const changed = await tx
        .update(trialSegments)
        .set({ viewedAt: new Date(), updatedAt: new Date() })
        .where(and(
          eq(trialSegments.id, input.trialSegmentId),
          eq(trialSegments.trialRevisionId, input.trialRevisionId),
          eq(trialSegments.status, 'ready'),
        ))
        .returning({ id: trialSegments.id });
      if (changed.length !== 1) {
        throw new UserBookError('试读片段不存在或尚未准备好', 409);
      }
    });
    return state(userBookId);
  };

  return {
    getManifestAndHtml,
    enqueueTrialRevisionGenerations,
    approveDraftForTrial,
    selectTrialFragments,
    stateByRevisionId,
    state,
    resolveApproveOperation,
    runPreparedOperation,
    executeOperation,
    createStreamEmitter,
    streamOperation,
    streamApprove,
    retry,
    markViewed,
  };
}
