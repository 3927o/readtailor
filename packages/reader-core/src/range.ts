import { type Static, Type } from '@sinclair/typebox';
import { ReaderContractError } from './errors';
import { BlockPointSchema, type BlockPoint } from './point';

export const BlockRangeSchema = Type.Object({
  start: BlockPointSchema,
  end: BlockPointSchema,
}, { additionalProperties: false });
export type BlockRange = Static<typeof BlockRangeSchema>;

export type BlockLength = { blockIndex: number; utf16Length: number };

export function compareBlockPoints(left: BlockPoint, right: BlockPoint): number {
  return left.blockIndex === right.blockIndex
    ? left.offset - right.offset
    : left.blockIndex - right.blockIndex;
}

export function blockPointsEqual(left: BlockPoint, right: BlockPoint): boolean {
  return compareBlockPoints(left, right) === 0;
}

export function normalizeBlockRange(range: BlockRange): BlockRange {
  return compareBlockPoints(range.start, range.end) <= 0
    ? range
    : { start: range.end, end: range.start };
}

export function blockRangesEqual(left: BlockRange, right: BlockRange): boolean {
  return blockPointsEqual(left.start, right.start) && blockPointsEqual(left.end, right.end);
}

export function blockRangeContains(outer: BlockRange, inner: BlockRange): boolean {
  return compareBlockPoints(outer.start, inner.start) <= 0
    && compareBlockPoints(inner.end, outer.end) <= 0;
}

function requireLength(blocks: readonly BlockLength[], blockIndex: number, path: string): number {
  const block = blocks.find((candidate) => candidate.blockIndex === blockIndex);
  if (!block) throw new ReaderContractError('unknown_block', `unknown block ${blockIndex}`, path);
  return block.utf16Length;
}

export function validateBlockPoint(
  point: BlockPoint,
  blocks: readonly BlockLength[],
  path = 'point',
): void {
  if (!Number.isInteger(point.blockIndex) || point.blockIndex < 1) {
    throw new ReaderContractError('invalid_point', 'blockIndex must be a positive integer', `${path}.blockIndex`);
  }
  if (!Number.isInteger(point.offset) || point.offset < 0) {
    throw new ReaderContractError('invalid_point', 'offset must be a non-negative integer', `${path}.offset`);
  }
  const length = requireLength(blocks, point.blockIndex, `${path}.blockIndex`);
  if (point.offset > length) {
    throw new ReaderContractError('invalid_point', 'offset is outside the block', `${path}.offset`);
  }
}

export function validateBlockRange(
  range: BlockRange,
  blocks: readonly BlockLength[],
  path = 'range',
): void {
  validateBlockPoint(range.start, blocks, `${path}.start`);
  validateBlockPoint(range.end, blocks, `${path}.end`);
  if (compareBlockPoints(range.start, range.end) >= 0) {
    throw new ReaderContractError('invalid_range', 'range must be non-empty and ordered', path);
  }
}

export function quoteFromBlocks(
  blocks: readonly { blockIndex: number; text: string }[],
  range: BlockRange,
): string {
  validateBlockRange(
    range,
    blocks.map((block) => ({ blockIndex: block.blockIndex, utf16Length: block.text.length })),
  );
  const pieces: string[] = [];
  for (const block of blocks) {
    if (block.blockIndex < range.start.blockIndex || block.blockIndex > range.end.blockIndex) continue;
    const start = block.blockIndex === range.start.blockIndex ? range.start.offset : 0;
    const end = block.blockIndex === range.end.blockIndex ? range.end.offset : block.text.length;
    pieces.push(block.text.slice(start, end));
  }
  return pieces.join('\n');
}
