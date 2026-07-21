import {
  blockRangesEqual,
  compareBlockPoints,
  type BlockPoint,
} from '@readtailor/reader-core';
import {
  TailoringError,
  type GenerationBlock,
  type TailoringGenerationInput,
} from './types';

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TailoringError('invalid_input', `${field} must not be empty`);
  }
}

function validatePoint(
  point: BlockPoint,
  blocksByIndex: ReadonlyMap<number, GenerationBlock>,
  field: string,
): void {
  if (!Number.isInteger(point.blockIndex) || point.blockIndex < 1) {
    throw new TailoringError('invalid_input', `${field}.blockIndex must be a positive integer`);
  }
  if (!Number.isInteger(point.offset) || point.offset < 0) {
    throw new TailoringError('invalid_input', `${field}.offset must be a non-negative integer`);
  }

  const block = blocksByIndex.get(point.blockIndex);
  if (!block) {
    throw new TailoringError('invalid_input', `${field} references a block outside the source`);
  }
  const sourceOffset = block.sourceOffset ?? 0;
  if (point.offset < sourceOffset || point.offset > sourceOffset + block.text.length) {
    throw new TailoringError(
      'invalid_input',
      `${field}.offset falls outside the supplied range of block ${point.blockIndex}`,
    );
  }
}

function validateSourceBlocks(blocks: GenerationBlock[]): ReadonlyMap<number, GenerationBlock> {
  if (blocks.length === 0) {
    throw new TailoringError('invalid_input', 'source.blocks must not be empty');
  }

  const blocksByIndex = new Map<number, GenerationBlock>();
  let previousIndex: number | null = null;
  for (const block of blocks) {
    if (!Number.isInteger(block.blockIndex) || block.blockIndex < 1) {
      throw new TailoringError('invalid_input', 'blockIndex must be a positive integer');
    }
    if (previousIndex !== null && block.blockIndex !== previousIndex + 1) {
      throw new TailoringError(
        'invalid_input',
        'source.blocks must be ordered and cover one continuous block range',
      );
    }
    if (blocksByIndex.has(block.blockIndex)) {
      throw new TailoringError('invalid_input', `duplicate blockIndex ${block.blockIndex}`);
    }
    blocksByIndex.set(block.blockIndex, block);
    previousIndex = block.blockIndex;
  }
  return blocksByIndex;
}

export function validateGenerationInput(
  input: TailoringGenerationInput,
): ReadonlyMap<number, GenerationBlock> {
  requireNonEmpty(input.userId, 'userId');
  requireNonEmpty(input.packageId, 'packageId');
  requireNonEmpty(input.packageVersion, 'packageVersion');
  requireNonEmpty(input.profiles.book.version, 'profiles.book.version');
  requireNonEmpty(input.profiles.reader.version, 'profiles.reader.version');
  requireNonEmpty(input.profiles.bookReader.version, 'profiles.bookReader.version');
  requireNonEmpty(input.model.modelId, 'model.modelId');
  requireNonEmpty(input.model.configVersion, 'model.configVersion');
  requireNonEmpty(input.source.sectionId, 'source.sectionId');
  if (!Number.isInteger(input.source.segment) || input.source.segment < 1) {
    throw new TailoringError('invalid_input', 'source.segment must be a positive integer');
  }
  if (!Number.isInteger(input.source.nodeOrder) || input.source.nodeOrder < 1) {
    throw new TailoringError('invalid_input', 'source.nodeOrder must be a positive integer');
  }
  requireNonEmpty(input.source.structuredHtml, 'source.structuredHtml');

  const blocksByIndex = validateSourceBlocks(input.source.blocks);
  validatePoint(input.source.range.start, blocksByIndex, 'source.range.start');
  validatePoint(input.source.range.end, blocksByIndex, 'source.range.end');
  if (compareBlockPoints(input.source.range.start, input.source.range.end) >= 0) {
    throw new TailoringError('invalid_input', 'source.range must be non-empty and ordered');
  }

  const firstBlock = input.source.blocks[0];
  const lastBlock = input.source.blocks[input.source.blocks.length - 1];
  if (!firstBlock || !lastBlock) {
    throw new TailoringError('invalid_input', 'source.blocks must not be empty');
  }
  if (
    input.source.range.start.blockIndex !== firstBlock.blockIndex ||
    input.source.range.end.blockIndex !== lastBlock.blockIndex
  ) {
    throw new TailoringError('invalid_input', 'source.range must cover all supplied source blocks');
  }

  requireNonEmpty(input.strategy.version, 'strategy.version');
  if (input.generationScope === 'trial') {
    if (input.strategy.kind !== 'strategy_draft' || input.strategy.status !== 'approved_for_trial') {
      throw new TailoringError(
        'invalid_strategy_reference',
        'trial generation requires an approved-for-trial strategy draft',
      );
    }
    if (!blockRangesEqual(input.fragmentRange, input.source.range)) {
      throw new TailoringError(
        'invalid_scope',
        'trial fragmentRange must exactly match the supplied source range',
      );
    }
  } else if (input.generationScope === 'formal') {
    if (input.strategy.kind !== 'strategy' || input.strategy.status !== 'active') {
      throw new TailoringError(
        'invalid_strategy_reference',
        'formal generation requires an active formal strategy',
      );
    }
    if (
      firstBlock.blockIndex !== 1 ||
      input.source.range.start.offset !== 0 ||
      input.source.range.end.offset !== (lastBlock.sourceOffset ?? 0) + lastBlock.text.length
    ) {
      throw new TailoringError(
        'invalid_scope',
        'formal generation source must cover the complete node',
      );
    }
  } else {
    throw new TailoringError('invalid_scope', 'unsupported generationScope');
  }

  return blocksByIndex;
}
