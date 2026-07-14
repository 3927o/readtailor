import {
  TailoringError,
  type GenerationBlock,
  type TailoringGenerationInput,
  type TextPoint,
  type TextRange,
} from './types';

function requireNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TailoringError('invalid_input', `${field} must not be empty`);
  }
}

export function comparePoints(left: TextPoint, right: TextPoint): number {
  if (left.block_index !== right.block_index) {
    return left.block_index - right.block_index;
  }
  return left.offset - right.offset;
}

export function rangesEqual(left: TextRange, right: TextRange): boolean {
  return comparePoints(left.start, right.start) === 0 && comparePoints(left.end, right.end) === 0;
}

export function rangeContains(outer: TextRange, inner: TextRange): boolean {
  return comparePoints(outer.start, inner.start) <= 0 && comparePoints(inner.end, outer.end) <= 0;
}

function validatePoint(
  point: TextPoint,
  blocksByIndex: ReadonlyMap<number, GenerationBlock>,
  field: string,
): void {
  if (!Number.isInteger(point.block_index) || point.block_index < 1) {
    throw new TailoringError('invalid_input', `${field}.block_index must be a positive integer`);
  }
  if (!Number.isInteger(point.offset) || point.offset < 0) {
    throw new TailoringError('invalid_input', `${field}.offset must be a non-negative integer`);
  }

  const block = blocksByIndex.get(point.block_index);
  if (!block) {
    throw new TailoringError('invalid_input', `${field} references a block outside the source`);
  }
  const sourceOffset = block.source_offset ?? 0;
  if (point.offset < sourceOffset || point.offset > sourceOffset + block.text.length) {
    throw new TailoringError(
      'invalid_input',
      `${field}.offset falls outside the supplied range of block ${point.block_index}`,
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
    if (!Number.isInteger(block.block_index) || block.block_index < 1) {
      throw new TailoringError('invalid_input', 'block_index must be a positive integer');
    }
    if (previousIndex !== null && block.block_index !== previousIndex + 1) {
      throw new TailoringError(
        'invalid_input',
        'source.blocks must be ordered and cover one continuous block range',
      );
    }
    if (blocksByIndex.has(block.block_index)) {
      throw new TailoringError('invalid_input', `duplicate block_index ${block.block_index}`);
    }
    blocksByIndex.set(block.block_index, block);
    previousIndex = block.block_index;
  }
  return blocksByIndex;
}

export function validateGenerationInput(
  input: TailoringGenerationInput,
): ReadonlyMap<number, GenerationBlock> {
  requireNonEmpty(input.user_id, 'user_id');
  requireNonEmpty(input.package_id, 'package_id');
  requireNonEmpty(input.package_version, 'package_version');
  requireNonEmpty(input.profiles.book.version, 'profiles.book.version');
  requireNonEmpty(input.profiles.reader.version, 'profiles.reader.version');
  requireNonEmpty(input.profiles.book_reader.version, 'profiles.book_reader.version');
  requireNonEmpty(input.model.model_id, 'model.model_id');
  requireNonEmpty(input.model.config_version, 'model.config_version');
  requireNonEmpty(input.source.section_id, 'source.section_id');
  if (!Number.isInteger(input.source.segment) || input.source.segment < 1) {
    throw new TailoringError('invalid_input', 'source.segment must be a positive integer');
  }
  if (!Number.isInteger(input.source.node_order) || input.source.node_order < 1) {
    throw new TailoringError('invalid_input', 'source.node_order must be a positive integer');
  }
  requireNonEmpty(input.source.structured_html, 'source.structured_html');

  const blocksByIndex = validateSourceBlocks(input.source.blocks);
  validatePoint(input.source.range.start, blocksByIndex, 'source.range.start');
  validatePoint(input.source.range.end, blocksByIndex, 'source.range.end');
  if (comparePoints(input.source.range.start, input.source.range.end) >= 0) {
    throw new TailoringError('invalid_input', 'source.range must be non-empty and ordered');
  }

  const firstBlock = input.source.blocks[0];
  const lastBlock = input.source.blocks[input.source.blocks.length - 1];
  if (!firstBlock || !lastBlock) {
    throw new TailoringError('invalid_input', 'source.blocks must not be empty');
  }
  if (
    input.source.range.start.block_index !== firstBlock.block_index ||
    input.source.range.end.block_index !== lastBlock.block_index
  ) {
    throw new TailoringError('invalid_input', 'source.range must cover all supplied source blocks');
  }

  requireNonEmpty(input.strategy.version, 'strategy.version');
  if (input.generation_scope === 'trial') {
    if (input.strategy.kind !== 'strategy_draft' || input.strategy.status !== 'approved_for_trial') {
      throw new TailoringError(
        'invalid_strategy_reference',
        'trial generation requires an approved-for-trial strategy draft',
      );
    }
    if (!rangesEqual(input.fragment_range, input.source.range)) {
      throw new TailoringError(
        'invalid_scope',
        'trial fragment_range must exactly match the supplied source range',
      );
    }
  } else if (input.generation_scope === 'formal') {
    if (input.strategy.kind !== 'strategy' || input.strategy.status !== 'active') {
      throw new TailoringError(
        'invalid_strategy_reference',
        'formal generation requires an active formal strategy',
      );
    }
    if (
      firstBlock.block_index !== 1 ||
      input.source.range.start.offset !== 0 ||
      input.source.range.end.offset !== (lastBlock.source_offset ?? 0) + lastBlock.text.length
    ) {
      throw new TailoringError(
        'invalid_scope',
        'formal generation source must cover the complete node',
      );
    }
  } else {
    throw new TailoringError('invalid_scope', 'unsupported generation_scope');
  }

  return blocksByIndex;
}
