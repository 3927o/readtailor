import { describe, expect, it } from 'vitest';
import {
  blockRangeContains,
  blockRangesEqual,
  compareBlockPoints,
  normalizeBlockRange,
  quoteFromBlocks,
  validateBlockRange,
} from './range';

describe('block ranges', () => {
  const blocks = [
    { blockIndex: 1, text: '中A😀' },
    { blockIndex: 2, text: '第二行' },
  ];

  it('compares, normalizes and contains left-closed right-open ranges', () => {
    const range = { start: { blockIndex: 1, offset: 1 }, end: { blockIndex: 2, offset: 2 } };
    expect(compareBlockPoints(range.start, range.end)).toBeLessThan(0);
    expect(normalizeBlockRange({ start: range.end, end: range.start })).toEqual(range);
    expect(blockRangesEqual(range, structuredClone(range))).toBe(true);
    expect(blockRangeContains(range, { start: { blockIndex: 1, offset: 2 }, end: { blockIndex: 2, offset: 1 } })).toBe(true);
  });

  it('extracts quotes using JavaScript UTF-16 offsets', () => {
    expect(quoteFromBlocks(blocks, {
      start: { blockIndex: 1, offset: 1 },
      end: { blockIndex: 2, offset: 2 },
    })).toBe('A😀\n第二');
  });

  it('rejects empty, reversed and out-of-block ranges', () => {
    const lengths = blocks.map((block) => ({ blockIndex: block.blockIndex, utf16Length: block.text.length }));
    expect(() => validateBlockRange({ start: { blockIndex: 1, offset: 1 }, end: { blockIndex: 1, offset: 1 } }, lengths)).toThrowError(expect.objectContaining({ code: 'invalid_range' }));
    expect(() => validateBlockRange({ start: { blockIndex: 2, offset: 1 }, end: { blockIndex: 1, offset: 1 } }, lengths)).toThrowError(expect.objectContaining({ code: 'invalid_range' }));
    expect(() => validateBlockRange({ start: { blockIndex: 1, offset: 0 }, end: { blockIndex: 2, offset: 4 } }, lengths)).toThrowError(expect.objectContaining({ code: 'invalid_point' }));
  });
});
