import { describe, expect, it } from 'vitest';
import type { ReaderNode, ReaderOutlineItem } from './api';
import { activeChapterUnit, buildChapterUnits } from './chapter';

function node(order: number, sectionId: string, characterCount = 100): ReaderNode {
  return {
    sectionId: sectionId,
    segment: 1,
    order,
    region: 'body',
    dataType: 'chapter',
    title: sectionId,
    parentSectionId: null,
    characterCount: characterCount,
    blockCount: 0,
    tailoringEligible: true,
    exclusionReason: null,
    nodeAbsoluteStart: 0,
    blocks: [],
  };
}

describe('reader chapter units', () => {
  it('uses each leaf outline item as a reader chapter', () => {
    const outline: ReaderOutlineItem[] = [
      { sectionId: 'book', dataType: 'book', title: '全书', parentSectionId: null, firstNodeOrder: 1 },
      { sectionId: 'part', dataType: 'part', title: '第四部', parentSectionId: 'book', firstNodeOrder: 1 },
      { sectionId: 'chapter-1', dataType: 'chapter', title: '蜂蜜供品', parentSectionId: 'part', firstNodeOrder: 1 },
      { sectionId: 'chapter-1-sub-1', dataType: 'subsection', title: '1', parentSectionId: 'chapter-1', firstNodeOrder: 1 },
      { sectionId: 'chapter-1-sub-2', dataType: 'subsection', title: '2', parentSectionId: 'chapter-1', firstNodeOrder: 2 },
      { sectionId: 'chapter-2', dataType: 'chapter', title: '求救的叫声', parentSectionId: 'part', firstNodeOrder: 3 },
    ];

    const units = buildChapterUnits(outline, [node(1, 'chapter-1-sub-1'), node(2, 'chapter-1-sub-2', 150), node(3, 'chapter-2', 200)]);

    expect(units).toEqual([
      { sectionId: 'chapter-1-sub-1', title: '1', startOrder: 1, endOrder: 2, characterCount: 100 },
      { sectionId: 'chapter-1-sub-2', title: '2', startOrder: 2, endOrder: 3, characterCount: 150 },
      { sectionId: 'chapter-2', title: '求救的叫声', startOrder: 3, endOrder: null, characterCount: 200 },
    ]);
    expect(activeChapterUnit(units, 2)?.sectionId).toBe('chapter-1-sub-2');
    expect(activeChapterUnit(units, 3)?.sectionId).toBe('chapter-2');
  });

  it('deduplicates leaf headings that begin at the same reading node', () => {
    const outline: ReaderOutlineItem[] = [
      { sectionId: 'section-1', dataType: 'section', title: '开始', parentSectionId: null, firstNodeOrder: 1 },
      { sectionId: 'section-2', dataType: 'section', title: '继续', parentSectionId: null, firstNodeOrder: 1 },
    ];

    expect(buildChapterUnits(outline, [node(1, 'section-1'), node(2, 'section-2')]).map((unit) => unit.sectionId))
      .toEqual(['section-1']);
  });
});
