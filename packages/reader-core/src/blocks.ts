import { ReaderContractError } from './errors';
import type { ReadingManifestNode } from './manifest-schema';
import type { BlockPoint } from './point';
import type { BlockRange } from './range';
import { validateBlockPoint, validateBlockRange } from './range';

export type CanonicalReadingBlock = {
  blockIndex: number;
  kind: string;
  text: string;
  utf16Length: number;
};

export function canonicalBlockLength(text: string): number {
  return text.length;
}

export function validateCanonicalBlocks(blocks: readonly CanonicalReadingBlock[]): void {
  blocks.forEach((block, index) => {
    const path = `blocks[${index}]`;
    if (block.blockIndex !== index + 1) {
      throw new ReaderContractError('invalid_manifest_semantics', 'canonical block indexes must be contiguous', `${path}.blockIndex`);
    }
    if (!block.kind) {
      throw new ReaderContractError('invalid_manifest_semantics', 'canonical block kind must not be empty', `${path}.kind`);
    }
    if (block.utf16Length !== canonicalBlockLength(block.text)) {
      throw new ReaderContractError('invalid_manifest_semantics', 'canonical block UTF-16 length does not match text', `${path}.utf16Length`);
    }
  });
}

function blockLengths(blocks: readonly CanonicalReadingBlock[]) {
  return blocks.map((block) => ({ blockIndex: block.blockIndex, utf16Length: block.utf16Length }));
}

export function validatePointAgainstBlocks(
  point: BlockPoint,
  blocks: readonly CanonicalReadingBlock[],
): void {
  validateCanonicalBlocks(blocks);
  validateBlockPoint(point, blockLengths(blocks));
}

export function validateRangeAgainstBlocks(
  range: BlockRange,
  blocks: readonly CanonicalReadingBlock[],
): void {
  validateCanonicalBlocks(blocks);
  validateBlockRange(range, blockLengths(blocks));
}

export function validateCanonicalBlocksAgainstManifestNode(
  blocks: readonly CanonicalReadingBlock[],
  node: ReadingManifestNode,
): void {
  validateCanonicalBlocks(blocks);
  if (blocks.length !== node.blockCount || blocks.length !== node.blocks.length) {
    throw new ReaderContractError('invalid_manifest_semantics', 'canonical block count does not match manifest node', 'blocks');
  }
  blocks.forEach((block, index) => {
    const expected = node.blocks[index];
    if (!expected) return;
    const path = `blocks[${index}]`;
    if (block.blockIndex !== expected.blockIndex) {
      throw new ReaderContractError('invalid_manifest_semantics', 'canonical block index does not match manifest', `${path}.blockIndex`);
    }
    if (block.kind !== expected.kind) {
      throw new ReaderContractError('invalid_manifest_semantics', 'canonical block kind does not match manifest', `${path}.kind`);
    }
    if (block.text.length !== block.utf16Length || block.utf16Length !== expected.blockUtf16Length) {
      throw new ReaderContractError('invalid_manifest_semantics', 'canonical block length does not match manifest', `${path}.utf16Length`);
    }
  });
}
