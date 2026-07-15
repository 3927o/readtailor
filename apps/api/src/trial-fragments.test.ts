import { describe, expect, it } from 'vitest';
import { resolveTrialFragmentRanges, UserBookError } from './user-books';

describe('resolveTrialFragmentRanges', () => {
  const nodes = [{
    section_id: 'chapter-1',
    segment: 1,
    blocks: [
      { block_index: 1, text: '开头' },
      { block_index: 2, text: '甲😀乙' },
      { block_index: 3, text: '结尾' },
    ],
  }];

  it('derives exact UTF-16 offsets from the selected source blocks', () => {
    expect(resolveTrialFragmentRanges([{
      section_id: 'chapter-1',
      segment: 1,
      tag: 'typical',
      range: { start: { block_index: 1 }, end: { block_index: 2 } },
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
      section_id: 'chapter-1',
      segment: 1,
      tag: 'hardest',
      range: { start: { block_index: 2 }, end: { block_index: 9 } },
      reason: '覆盖较高难度内容的处理效果。',
    }], nodes)).toThrowError(UserBookError);
  });
});
