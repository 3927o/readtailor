import type { ReaderNode, ReaderOutlineItem } from './api';

export interface ReaderChapterUnit {
  sectionId: string;
  title: string;
  startOrder: number;
  endOrder: number | null;
  characterCount: number;
}

export function buildChapterUnits(
  outline: ReaderOutlineItem[],
  nodes: ReaderNode[],
): ReaderChapterUnit[] {
  const parentIds = new Set(
    outline
      .map((item) => item.parent_section_id)
      .filter((sectionId): sectionId is string => Boolean(sectionId)),
  );
  const candidates = outline.filter((item) => !parentIds.has(item.section_id));
  const byStart = new Map<number, ReaderOutlineItem>();
  for (const item of candidates) {
    if (!byStart.has(item.first_node_order)) byStart.set(item.first_node_order, item);
  }
  const starts = [...byStart.values()].sort((left, right) => left.first_node_order - right.first_node_order);
  if (starts.length === 0 && nodes[0]) {
    starts.push({
      section_id: nodes[0].section_id,
      data_type: nodes[0].data_type,
      title: nodes[0].title || '正文',
      parent_section_id: null,
      first_node_order: nodes[0].order,
    });
  }
  return starts.map((item, index) => {
    const next = starts[index + 1];
    const characterCount = nodes
      .filter((node) => node.order >= item.first_node_order && (!next || node.order < next.first_node_order))
      .reduce((sum, node) => sum + node.character_count, 0);
    return {
      sectionId: item.section_id,
      title: item.title,
      startOrder: item.first_node_order,
      endOrder: next?.first_node_order ?? null,
      characterCount,
    };
  });
}

export function activeChapterUnit(
  units: ReaderChapterUnit[],
  order: number,
): ReaderChapterUnit | null {
  return [...units].filter((unit) => unit.startOrder <= order).at(-1) ?? units[0] ?? null;
}
