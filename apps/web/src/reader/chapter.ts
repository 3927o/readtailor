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
      .map((item) => item.parentSectionId)
      .filter((sectionId): sectionId is string => Boolean(sectionId)),
  );
  const candidates = outline.filter((item) => !parentIds.has(item.sectionId));
  const byStart = new Map<number, ReaderOutlineItem>();
  for (const item of candidates) {
    if (!byStart.has(item.firstNodeOrder)) byStart.set(item.firstNodeOrder, item);
  }
  const starts = [...byStart.values()].sort((left, right) => left.firstNodeOrder - right.firstNodeOrder);
  if (starts.length === 0 && nodes[0]) {
    starts.push({
      sectionId: nodes[0].sectionId,
      dataType: nodes[0].dataType,
      title: nodes[0].title || '正文',
      parentSectionId: null,
      firstNodeOrder: nodes[0].order,
    });
  }
  return starts.map((item, index) => {
    const next = starts[index + 1];
    const characterCount = nodes
      .filter((node) => node.order >= item.firstNodeOrder && (!next || node.order < next.firstNodeOrder))
      .reduce((sum, node) => sum + node.characterCount, 0);
    return {
      sectionId: item.sectionId,
      title: item.title,
      startOrder: item.firstNodeOrder,
      endOrder: next?.firstNodeOrder ?? null,
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
