import { describe, expect, it } from 'vitest';
import fixtureValue from './fixtures/reading-nodes-1.0.valid.json';
import {
  canonicalBlockLength,
  validateCanonicalBlocks,
  validateCanonicalBlocksAgainstManifestNode,
  validatePointAgainstBlocks,
  validateRangeAgainstBlocks,
  type CanonicalReadingBlock,
} from './blocks';
import { parseReadingManifest } from './manifest';

describe('canonical blocks', () => {
  const blocks: CanonicalReadingBlock[] = [
    { blockIndex: 1, kind: 'p', text: '中文😀', utf16Length: 4 },
    { blockIndex: 2, kind: 'figure', text: '', utf16Length: 0 },
  ];

  it('uses UTF-16 code units and validates points and ranges', () => {
    expect(canonicalBlockLength('A😀中')).toBe(4);
    expect(() => validateCanonicalBlocks(blocks)).not.toThrow();
    expect(() => validatePointAgainstBlocks({ blockIndex: 2, offset: 0 }, blocks)).not.toThrow();
    expect(() => validateRangeAgainstBlocks({
      start: { blockIndex: 1, offset: 0 },
      end: { blockIndex: 2, offset: 0 },
    }, blocks)).not.toThrow();
  });

  it('validates adapter output against manifest block metadata', () => {
    const node = parseReadingManifest(fixtureValue).nodes[1]!;
    expect(() => validateCanonicalBlocksAgainstManifestNode(blocks, node)).not.toThrow();
    expect(() => validateCanonicalBlocksAgainstManifestNode([
      { ...blocks[0]!, kind: 'pre' },
      blocks[1]!,
    ], node)).toThrowError(expect.objectContaining({
      code: 'invalid_manifest_semantics',
      path: 'blocks[0].kind',
    }));
  });
});
