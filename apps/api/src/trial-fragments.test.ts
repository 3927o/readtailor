import { describe, expect, it } from 'vitest';
import { resolveTrialFragmentRanges, UserBookError } from './user-books';

describe('resolveTrialFragmentRanges', () => {
  const nodes = [{
    sectionId: 'chapter-1',
    segment: 1,
    blocks: [
      { blockIndex: 1, text: '开头' },
      { blockIndex: 2, text: '甲😀乙' },
      { blockIndex: 3, text: '结尾' },
    ],
  }];

  it('derives exact UTF-16 offsets from the selected source blocks', () => {
    expect(resolveTrialFragmentRanges([{
      sectionId: 'chapter-1',
      segment: 1,
      tag: 'typical',
      range: { start: { blockIndex: 1 }, end: { blockIndex: 2 } },
      reason: '覆盖典型内容的处理效果。',
    }], nodes)).toEqual([{
      sectionId: 'chapter-1',
      segment: 1,
      tag: 'typical',
      reason: '覆盖典型内容的处理效果。',
      range: {
        start: { blockIndex: 1, offset: 0 },
        end: { blockIndex: 2, offset: 4 },
      },
    }]);
  });

  it('rejects a block range outside the candidate node', () => {
    expect(() => resolveTrialFragmentRanges([{
      sectionId: 'chapter-1',
      segment: 1,
      tag: 'hardest',
      range: { start: { blockIndex: 2 }, end: { blockIndex: 9 } },
      reason: '覆盖较高难度内容的处理效果。',
    }], nodes)).toThrowError(UserBookError);
  });
});
