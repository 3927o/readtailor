// @vitest-environment happy-dom

// §11.5 / §2.5: the reader saves a position as { blockIndex, offset } and restores it by mapping
// that offset back to a DOM boundary. `offsetWithinBlock` (save) MUST be the exact inverse of
// `domBoundaryForOffset`/`boundaryAt` (restore) or a saved anchor drifts on reopen — and the same
// pair backs highlight ranges (§11.7). These round-trip tests lock that symmetry, including the
// enumeration edge cases the block algorithm handles specially (<br>, nested lists inside an <li>).

import { describe, expect, it } from 'vitest';
import { domBoundaryForOffset, offsetWithinBlock, readingBlocks } from './content';

function root(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

// The block's standard-text length in the projection coordinate system, discovered by walking the
// forward map until it stops resolving — independent of the enumeration internals.
function projectedLength(block: HTMLElement): number {
  let length = 0;
  while (domBoundaryForOffset(block, length + 1)) length += 1;
  return length;
}

function roundTrip(block: HTMLElement, offset: number): number {
  const boundary = domBoundaryForOffset(block, offset);
  if (!boundary) throw new Error(`no DOM boundary for offset ${offset}`);
  return offsetWithinBlock(block, boundary.container, boundary.offset);
}

describe('reader position offset round-trip', () => {
  it('round-trips every offset of a plain paragraph', () => {
    const block = readingBlocks(root('<p>第一段落文本</p>'))[0]!;
    const length = projectedLength(block);
    expect(length).toBe(6);
    for (let offset = 0; offset <= length; offset += 1) {
      expect(roundTrip(block, offset)).toBe(offset);
    }
  });

  it('round-trips across inline elements without counting the tags', () => {
    const block = readingBlocks(root('<p>甲<strong>关键</strong>乙</p>'))[0]!;
    const length = projectedLength(block);
    expect(length).toBe(4); // 甲 + 关键 + 乙, tags contribute nothing
    for (let offset = 0; offset <= length; offset += 1) {
      expect(roundTrip(block, offset)).toBe(offset);
    }
  });

  it('counts a <br> as exactly one character on both sides of the map', () => {
    const block = readingBlocks(root('<p>上<br>下</p>'))[0]!;
    const length = projectedLength(block);
    expect(length).toBe(3); // 上 \n 下
    for (let offset = 0; offset <= length; offset += 1) {
      expect(roundTrip(block, offset)).toBe(offset);
    }
  });

  it('skips a nested list inside an <li> so trailing text keeps its offset', () => {
    // The <li>'s own block is "前" + "后"; the nested <ul> is a separate block and must not be
    // counted, matching boundaryAt's skipNestedLists branch.
    const li = readingBlocks(root('<ul><li>前<ul><li>子项</li></ul>后</li></ul>'))
      .find((block) => block.tagName === 'LI' && block.textContent?.startsWith('前'))!;
    expect(li).toBeTruthy();
    const length = projectedLength(li);
    expect(length).toBe(2); // 前 + 后, nested "子项" excluded
    for (let offset = 0; offset <= length; offset += 1) {
      expect(roundTrip(li, offset)).toBe(offset);
    }
  });

  it('enumerates blocks in document order so blockIndex is positional', () => {
    const blocks = readingBlocks(root('<p>甲</p><p>乙</p><p>丙</p>'));
    expect(blocks.map((block) => block.textContent)).toEqual(['甲', '乙', '丙']);
  });
});
