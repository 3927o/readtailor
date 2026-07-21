import { describe, expect, it } from 'vitest';
import fixtureValue from './fixtures/reading-nodes-1.0.valid.json';
import { createManifestIndex, findBlock, findNode, findNodeByOrder, requireBlock, requireNode } from './manifest-index';
import { parseReadingManifest } from './manifest';
import { absoluteCharacterOffsetForPoint, blockPointForAbsoluteCharacterOffset } from './point';

describe('manifest index', () => {
  const manifest = parseReadingManifest(fixtureValue);
  const index = createManifestIndex(manifest);

  it('finds nodes and blocks by their stable coordinates', () => {
    const node = requireNode(index, 'chapter-1', 1);
    expect(findNode(index, 'missing', 1)).toBeUndefined();
    expect(findNodeByOrder(index, 2)).toBe(node);
    expect(requireBlock(node, 2).kind).toBe('figure');
    expect(findBlock(node, 3)).toBeUndefined();
    expect(() => requireNode(index, 'missing', 1)).toThrowError(expect.objectContaining({ code: 'unknown_node' }));
    expect(() => requireBlock(node, 3)).toThrowError(expect.objectContaining({ code: 'unknown_block' }));
  });

  it('converts block points and absolute UTF-16 offsets', () => {
    const node = requireNode(index, 'chapter-1', 1);
    expect(absoluteCharacterOffsetForPoint(node, { blockIndex: 1, offset: 3 })).toBe(4);
    expect(blockPointForAbsoluteCharacterOffset(node, 4)).toEqual({ blockIndex: 1, offset: 3 });
    expect(blockPointForAbsoluteCharacterOffset(node, 5)).toEqual({ blockIndex: 2, offset: 0 });
  });
});
