// @vitest-environment happy-dom

// §11.7 highlights share the annotation coordinate system (reading_contract §2.5): a selection folds
// to a { start, end } block range (rangeFromSelection), and that range renders back to the same
// characters (applyReaderMarks). These tests lock that inverse symmetry, the highlight∩annotation
// overlap (both marks must survive), cross-block spans, and the node-confinement rule.

import { describe, expect, it } from 'vitest';
import type { Highlight } from './api';
import type { TailoredAnnotation } from '../user-books/api';
import {
  applyReaderMarks,
  domRangeForReaderRange,
  quoteForReaderRange,
  rangeFromSelection,
  readerBlockText,
  readingBlocks,
} from './content';

function fragment(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function contentRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.className = 'reader-original';
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function highlight(range: Highlight['range'], overrides: Partial<Highlight> = {}): Highlight {
  return {
    id: 'h',
    sectionId: 's',
    segment: 1,
    range,
    note: null,
    quoteSnapshot: '',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  };
}

function annotation(range: TailoredAnnotation['range'], id: string): TailoredAnnotation {
  return { id, range, content: '解释' };
}

describe('applyReaderMarks (highlights)', () => {
  it('wraps a single-block highlight and tags it with the id', () => {
    const html = applyReaderMarks('<p>甲乙丙丁戊</p>', [], [
      highlight({ start: { blockIndex: 1, offset: 1 }, end: { blockIndex: 1, offset: 4 } }, { id: 'h1' }),
    ]);
    const mark = fragment(html).querySelector<HTMLElement>('[data-highlight-id="h1"]');
    expect(mark?.className).toBe('reader-highlight');
    expect(mark?.textContent).toBe('乙丙丁');
  });

  it('flags a highlight carrying a note with data-highlight-has-note', () => {
    const html = applyReaderMarks('<p>甲乙丙</p>', [], [
      highlight(
        { start: { blockIndex: 1, offset: 0 }, end: { blockIndex: 1, offset: 2 } },
        { id: 'h-note', note: '我的想法', quoteSnapshot: '甲乙' },
      ),
    ]);
    const mark = fragment(html).querySelector<HTMLElement>('[data-highlight-id="h-note"]');
    expect(mark?.dataset.highlightHasNote).toBe('true');
    expect(mark?.getAttribute('aria-label')).toContain('笔记');
  });

  it('spans a cross-block highlight with one mark per block sharing the id', () => {
    const html = applyReaderMarks('<p>第一段结尾</p><p>第二段开头</p>', [], [
      highlight({ start: { blockIndex: 1, offset: 3 }, end: { blockIndex: 2, offset: 3 } }, { id: 'h-span' }),
    ]);
    const rendered = fragment(html);
    const paragraphs = rendered.querySelectorAll('p');
    expect(rendered.querySelectorAll('[data-highlight-id="h-span"]')).toHaveLength(2);
    expect(paragraphs[0]?.querySelector('mark')?.textContent).toBe('结尾');
    expect(paragraphs[1]?.querySelector('mark')?.textContent).toBe('第二段');
    expect(rendered.textContent).toBe('第一段结尾第二段开头');
  });

  it('nests a highlight overlapping an annotation so both survive on the shared characters', () => {
    // 甲乙丙丁戊: annotation covers 乙丙丁 (1..4), highlight covers 丁戊 (3..5); overlap = 丁.
    const html = applyReaderMarks(
      '<p>甲乙丙丁戊</p>',
      [annotation({ start: { blockIndex: 1, offset: 1 }, end: { blockIndex: 1, offset: 4 } }, 'a1')],
      [highlight({ start: { blockIndex: 1, offset: 3 }, end: { blockIndex: 1, offset: 5 } }, { id: 'h1' })],
    );
    const rendered = fragment(html);
    // Text is never rewritten by the mark pass.
    expect(rendered.textContent).toBe('甲乙丙丁戊');
    // Each overlay covers exactly its range even though extractContents split one of them.
    const annoText = [...rendered.querySelectorAll('[data-annotation-id="a1"]')].map((node) => node.textContent).join('');
    const hlText = [...rendered.querySelectorAll('[data-highlight-id="h1"]')].map((node) => node.textContent).join('');
    expect(annoText).toBe('乙丙丁');
    expect(hlText).toBe('丁戊');
    // The shared char 丁 sits inside BOTH a highlight mark and an annotation mark (nested either way).
    const overlap = rendered.querySelector(
      '[data-annotation-id="a1"] [data-highlight-id="h1"], [data-highlight-id="h1"] [data-annotation-id="a1"]',
    );
    expect(overlap?.textContent).toBe('丁');
  });
});

describe('rangeFromSelection', () => {
  it('folds a text selection back to the block range that re-marks the same characters', () => {
    const root = contentRoot('<p>甲乙丙丁戊</p>');
    const text = root.querySelector('p')!.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 1); // before 乙
    range.setEnd(text, 4); // after 丁
    const nodeRange = rangeFromSelection(root, range);
    expect(nodeRange).toEqual({
      start: { blockIndex: 1, offset: 1 },
      end: { blockIndex: 1, offset: 4 },
    });
    // Round-trip: the folded range re-marks exactly the selected characters.
    const html = applyReaderMarks('<p>甲乙丙丁戊</p>', [], [highlight(nodeRange!, { id: 'rt' })]);
    expect(fragment(html).querySelector('[data-highlight-id="rt"]')?.textContent).toBe('乙丙丁');
    root.remove();
  });

  it('rebuilds a selection across inline seams without changing its logical range', () => {
    const root = contentRoot('<p>甲<strong>关键</strong>乙</p>');
    const strongText = root.querySelector('strong')!.firstChild as Text;
    const original = document.createRange();
    original.setStart(strongText, 0);
    original.setEnd(strongText, strongText.length);
    const logical = rangeFromSelection(root, original)!;

    const rebuilt = domRangeForReaderRange(root, logical);

    expect(rebuilt?.toString()).toBe('关键');
    expect(rebuilt && rangeFromSelection(root, rebuilt)).toEqual(logical);
    root.remove();
  });

  it('binds an endpoint inside a nested <li> to its innermost block (not the ancestor)', () => {
    const root = contentRoot('<ul><li>外<ul><li>内层文字</li></ul></li></ul>');
    const blocks = readingBlocks(root);
    const innerLi = root.querySelectorAll('li')[1]!;
    const innerBlockIndex = blocks.indexOf(innerLi) + 1;
    const innerText = innerLi.firstChild as Text; // 内层文字
    const range = document.createRange();
    range.setStart(innerText, 1); // 内|层文字
    range.setEnd(innerText, 3); // 内层文|字
    expect(rangeFromSelection(root, range)).toEqual({
      start: { blockIndex: innerBlockIndex, offset: 1 },
      end: { blockIndex: innerBlockIndex, offset: 3 },
    });
    root.remove();
  });

  it('rejects a selection whose endpoints leave the content root', () => {
    const root = contentRoot('<p>甲乙丙</p>');
    const outside = document.createElement('p');
    outside.textContent = '别处';
    document.body.append(outside);
    const range = document.createRange();
    range.setStart(root.querySelector('p')!.firstChild!, 0);
    range.setEnd(outside.firstChild!, 2);
    expect(rangeFromSelection(root, range)).toBeNull();
    root.remove();
    outside.remove();
  });

  it('returns null for a collapsed selection', () => {
    const root = contentRoot('<p>甲乙丙</p>');
    const text = root.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 2);
    expect(rangeFromSelection(root, range)).toBeNull();
    root.remove();
  });
});

describe('question-context quote projection', () => {
  it('slices a cross-block range in the same UTF-16 coordinates as highlights', () => {
    const root = contentRoot('<p>甲😀乙<br>丙</p><p>第二段内容</p>');
    expect(quoteForReaderRange(root, {
      start: { blockIndex: 1, offset: 1 },
      end: { blockIndex: 2, offset: 3 },
    })).toBe('😀乙\n丙\n第二段');
    root.remove();
  });

  it('skips a nested list when projecting its owning list item', () => {
    const root = contentRoot('<ul><li id="outer">前<ul><li>子项</li></ul>后</li></ul>');
    expect(readerBlockText(root.querySelector('#outer')!)).toBe('前后');
    root.remove();
  });
});
