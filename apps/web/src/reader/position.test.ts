// @vitest-environment happy-dom

// §11.5 / §2.5: the reader saves a position as { blockIndex, offset } and restores it by mapping
// that offset back to a DOM boundary. `offsetWithinBlock` (save) MUST be the exact inverse of
// `domBoundaryForOffset`/`boundaryAt` (restore) or a saved anchor drifts on reopen — and the same
// pair backs highlight ranges (§11.7). These round-trip tests lock that symmetry, including the
// enumeration edge cases the block algorithm handles specially (<br>, nested lists inside an <li>).

import { describe, expect, it } from 'vitest';
import {
  domBoundaryForOffset,
  nearestReaderAnchor,
  offsetWithinBlock,
  readingBlockForDomPoint,
  readingBlocks,
} from './content';
import type { AnchorProbe } from './content';

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

// §3.1: a DOM point binds to the INNERMOST enclosing block, never the ancestor block a forward
// `contains` scan would hit first. This keeps the saved offset in the same text-projection
// coordinate system the block was enumerated in (fix §1.2).
describe('readingBlockForDomPoint block ownership', () => {
  it('binds nested-list text to the inner <li>, and trailing text to the outer <li>', () => {
    const container = root('<ul><li>前<ul><li>子项</li></ul>后</li></ul>');
    const blocks = readingBlocks(container);
    const inner = blocks.find((block) => block.tagName === 'LI' && block.textContent === '子项')!;
    const outer = blocks.find((block) => block.tagName === 'LI' && block.textContent?.startsWith('前'))!;
    expect(inner).toBeTruthy();
    expect(outer).toBeTruthy();
    expect(readingBlockForDomPoint(blocks, inner.firstChild!)).toBe(inner);
    const trailing = [...outer.childNodes].find((node) => node.textContent === '后')!;
    expect(readingBlockForDomPoint(blocks, trailing)).toBe(outer);
    // The chosen inner block round-trips its own offset, so save→restore returns the same character.
    expect(roundTrip(inner, 1)).toBe(1);
  });

  it('binds figcaption text to the figcaption, not the enclosing figure', () => {
    const container = root('<figure><img src="x"><figcaption>图注文字</figcaption></figure>');
    const blocks = readingBlocks(container);
    const figure = blocks.find((block) => block.tagName === 'FIGURE')!;
    const figcaption = blocks.find((block) => block.tagName === 'FIGCAPTION')!;
    expect(figure).toBeTruthy();
    expect(readingBlockForDomPoint(blocks, figcaption.firstChild!)).toBe(figcaption);
  });

  it('binds inline markup to its enclosing paragraph block', () => {
    const container = root('<p>甲<strong>关键</strong>乙</p>');
    const blocks = readingBlocks(container);
    const strongText = container.querySelector('strong')!.firstChild!;
    expect(readingBlockForDomPoint(blocks, strongText)).toBe(blocks[0]);
  });
});

// §3.1: a fake probe supplies deterministic caret hits and rects so the resolver's ordering
// (precise caret → nearest block → nearest character → null) is testable without a layout engine.
// It recovers each boundary's char offset via offsetWithinBlock (itself locked by the round-trip
// tests above), so `topForOffset` can key line geometry on the true offset, including the end.
function readerRoot(html: string): HTMLElement {
  return root(`<div class="reader-original">${html}</div>`).querySelector<HTMLElement>('.reader-original')!;
}

function fakeProbe(
  block: HTMLElement,
  topForOffset: (offset: number) => number | null,
  caret: { node: Node; offset: number } | null,
  boxes: Map<HTMLElement, { top: number; bottom: number }>,
): AnchorProbe {
  return {
    caretAtPoint: () => caret,
    boundaryTop: (boundary) => topForOffset(offsetWithinBlock(block, boundary.container, boundary.offset)),
    blockBox: (candidate) => boxes.get(candidate) ?? null,
  };
}

describe('nearestReaderAnchor resolution order', () => {
  it('resolves a precise caret hit to its innermost block and offset', () => {
    const rdr = readerRoot('<p>甲<strong>关键</strong>乙</p>');
    const block = readingBlocks(rdr)[0]!;
    const strongText = rdr.querySelector('strong')!.firstChild!;
    const anchor = nearestReaderAnchor([rdr], 0, 0, fakeProbe(block, () => 0, { node: strongText, offset: 1 }, new Map()));
    // 甲(1) + 关(1) folded into the paragraph's standard text ⇒ offset 2.
    expect(anchor).toMatchObject({ blockIndex: 1, offset: 2 });
    expect(anchor!.block).toBe(block);
  });

  it('on a caret miss, snaps to the nearest original-text character on the anchor line', () => {
    const rdr = readerRoot('<p>ABCDEFGH</p>');
    const block = readingBlocks(rdr)[0]!;
    const boxes = new Map([[block, { top: 160, bottom: 180 }]]);
    // Two visual lines: offsets 0–3 on the first, 4–8 on the second (the anchor line at y=178).
    const anchor = nearestReaderAnchor([rdr], 0, 178, fakeProbe(block, (off) => (off <= 3 ? 160 : 180), null, boxes));
    expect(anchor).toMatchObject({ blockIndex: 1, offset: 4 });
  });

  it('returns null — never chapter start — when nothing measurable is under the anchor line', () => {
    const rdr = readerRoot('<p>ABCD</p>');
    const block = readingBlocks(rdr)[0]!;
    // caret misses and no block has a measurable box → decline instead of fabricating block 1.
    expect(nearestReaderAnchor([rdr], 0, 178, fakeProbe(block, () => null, null, new Map()))).toBeNull();
  });

  it('falls to the nearest measurable character when the block end has no rect', () => {
    const rdr = readerRoot('<p>ABCDEFGH</p>');
    const block = readingBlocks(rdr)[0]!;
    const boxes = new Map([[block, { top: 160, bottom: 210 }]]);
    // The trailing offsets (7–8) have no rect; the resolver must land on the closest measurable
    // character (offset 4 at y=200) rather than returning null or collapsing to the block top (0).
    const topForOffset = (off: number) => (off >= 7 ? null : off <= 3 ? 160 : 200);
    const anchor = nearestReaderAnchor([rdr], 0, 205, fakeProbe(block, topForOffset, null, boxes));
    expect(anchor).not.toBeNull();
    expect(anchor!.offset).toBe(4);
  });
});
