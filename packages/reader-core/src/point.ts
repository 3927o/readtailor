import { type Static, Type } from '@sinclair/typebox';
import { ReaderContractError } from './errors';
import type { ReadingManifestNode } from './manifest-schema';

export const BlockPointSchema = Type.Object({
  blockIndex: Type.Integer({ minimum: 1 }),
  offset: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type BlockPoint = Static<typeof BlockPointSchema>;

export const NodeLocatorSchema = Type.Object({
  sectionId: Type.String({ minLength: 1 }),
  segment: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
export type NodeLocator = Static<typeof NodeLocatorSchema>;

export function absoluteCharacterOffsetForPoint(
  node: ReadingManifestNode,
  point: BlockPoint,
): number {
  const block = node.blocks[point.blockIndex - 1];
  if (!block || block.blockIndex !== point.blockIndex) {
    throw new ReaderContractError('unknown_block', `unknown block ${point.blockIndex}`, 'blockIndex');
  }
  if (!Number.isInteger(point.offset) || point.offset < 0 || point.offset > block.blockUtf16Length) {
    throw new ReaderContractError('invalid_point', 'point offset is outside the block', 'offset');
  }
  return block.blockAbsoluteStart + point.offset;
}

export function blockPointForAbsoluteCharacterOffset(
  node: ReadingManifestNode,
  absoluteOffset: number,
): BlockPoint {
  if (
    !Number.isInteger(absoluteOffset)
    || absoluteOffset < node.nodeAbsoluteStart
    || absoluteOffset > node.nodeAbsoluteStart + node.characterCount
  ) {
    throw new ReaderContractError('invalid_point', 'absolute offset is outside the node', 'absoluteOffset');
  }
  for (let index = node.blocks.length - 1; index >= 0; index -= 1) {
    const block = node.blocks[index];
    if (block && absoluteOffset >= block.blockAbsoluteStart) {
      const offset = absoluteOffset - block.blockAbsoluteStart;
      if (offset <= block.blockUtf16Length) return { blockIndex: block.blockIndex, offset };
    }
  }
  throw new ReaderContractError('unknown_block', 'node has no block for the absolute offset');
}
