import type { TrialCandidate } from '@readtailor/contracts';
import type { TrialFragmentSelection } from '@readtailor/agent-kit';
import { nodeGenerations, trialSegments } from '@readtailor/database';
import { UserBookError } from '../errors';

type TrialNodeContent = {
  sectionId: string;
  segment: number;
  blocks: Array<{ blockIndex: number; text: string }>;
};

export function resolveTrialFragmentRanges(
  fragments: TrialFragmentSelection[],
  nodes: TrialNodeContent[],
): TrialCandidate[] {
  const nodesByKey = new Map(nodes.map((node) => [`${node.sectionId}\0${node.segment}`, node]));
  return fragments.map((fragment) => {
    const node = nodesByKey.get(`${fragment.sectionId}\0${fragment.segment}`);
    const blocksByIndex = new Map(node?.blocks.map((block) => [block.blockIndex, block]) ?? []);
    const startBlock = blocksByIndex.get(fragment.range.start.blockIndex);
    const endBlock = blocksByIndex.get(fragment.range.end.blockIndex);
    if (
      !node
      || !startBlock
      || !endBlock
      || fragment.range.start.blockIndex > fragment.range.end.blockIndex
    ) {
      throw new UserBookError('试读片段范围超出候选节点', 409);
    }
    if (
      fragment.range.start.blockIndex === fragment.range.end.blockIndex
      && endBlock.text.length === 0
    ) {
      throw new UserBookError('试读片段范围为空', 409);
    }
    return {
      sectionId: fragment.sectionId,
      segment: fragment.segment,
      reason: fragment.reason,
      tag: fragment.tag,
      range: {
        start: { blockIndex: fragment.range.start.blockIndex, offset: 0 },
        end: { blockIndex: fragment.range.end.blockIndex, offset: endBlock.text.length },
      },
    };
  });
}

type TrialRetrySegmentSource = Pick<
  typeof trialSegments.$inferSelect,
  | 'id'
  | 'ordinal'
  | 'sectionId'
  | 'segment'
  | 'startBlockIndex'
  | 'startOffset'
  | 'endBlockIndex'
  | 'endOffset'
  | 'selectionReason'
>;

type TrialRetryGenerationSource = Pick<
  typeof nodeGenerations.$inferSelect,
  | 'id'
  | 'generationScope'
  | 'trialSegmentId'
  | 'strategyDraftVersionId'
  | 'sectionId'
  | 'segment'
  | 'maxAttempts'
  | 'modelConfigId'
  | 'promptVersion'
>;

export function buildTrialRetryPlan(
  strategyDraftVersionId: string,
  segments: TrialRetrySegmentSource[],
  generations: TrialRetryGenerationSource[],
) {
  const ordered = [...segments].sort((left, right) => left.ordinal - right.ordinal);
  if (
    ordered.length !== 3
    || ordered.some((segment, index) => segment.ordinal !== index + 1)
    || new Set(ordered.map((segment) => segment.id)).size !== 3
  ) {
    throw new UserBookError('失败试读版本的片段数据不完整', 409);
  }
  const generationBySegmentId = new Map<string, TrialRetryGenerationSource>();
  for (const generation of generations) {
    if (
      generation.generationScope !== 'trial'
      || !generation.trialSegmentId
      || generation.strategyDraftVersionId !== strategyDraftVersionId
      || generationBySegmentId.has(generation.trialSegmentId)
    ) {
      throw new UserBookError('失败试读版本的生成任务数据不完整', 409);
    }
    generationBySegmentId.set(generation.trialSegmentId, generation);
  }
  if (generationBySegmentId.size !== 3) {
    throw new UserBookError('失败试读版本的生成任务数据不完整', 409);
  }
  return ordered.map((segment) => {
    const generation = generationBySegmentId.get(segment.id);
    if (
      !generation
      || generation.sectionId !== segment.sectionId
      || generation.segment !== segment.segment
    ) {
      throw new UserBookError('失败试读版本的片段与生成任务不一致', 409);
    }
    return { segment, generation };
  });
}
