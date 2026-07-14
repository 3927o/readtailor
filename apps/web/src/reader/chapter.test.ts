import { describe, expect, it } from 'vitest';
import type { ReaderNode, ReaderOutlineItem } from './api';
import { activeChapterUnit, buildChapterUnits } from './chapter';

function node(order: number, sectionId: string, characterCount = 100): ReaderNode {
  return {
    section_id: sectionId,
    segment: 1,
    order,
    region: 'body',
    data_type: 'chapter',
    title: sectionId,
    parent_section_id: null,
    character_count: characterCount,
    block_count: 1,
  };
}

describe('reader chapter units', () => {
  it('uses each leaf outline item as a reader chapter', () => {
    const outline: ReaderOutlineItem[] = [
      { section_id: 'book', data_type: 'book', title: '全书', parent_section_id: null, first_node_order: 1 },
      { section_id: 'part', data_type: 'part', title: '第四部', parent_section_id: 'book', first_node_order: 1 },
      { section_id: 'chapter-1', data_type: 'chapter', title: '蜂蜜供品', parent_section_id: 'part', first_node_order: 1 },
      { section_id: 'chapter-1-sub-1', data_type: 'subsection', title: '1', parent_section_id: 'chapter-1', first_node_order: 1 },
      { section_id: 'chapter-1-sub-2', data_type: 'subsection', title: '2', parent_section_id: 'chapter-1', first_node_order: 2 },
      { section_id: 'chapter-2', data_type: 'chapter', title: '求救的叫声', parent_section_id: 'part', first_node_order: 3 },
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
      { section_id: 'section-1', data_type: 'section', title: '开始', parent_section_id: null, first_node_order: 1 },
      { section_id: 'section-2', data_type: 'section', title: '继续', parent_section_id: null, first_node_order: 1 },
    ];

    expect(buildChapterUnits(outline, [node(1, 'section-1'), node(2, 'section-2')]).map((unit) => unit.sectionId))
      .toEqual(['section-1']);
  });
});
