// @vitest-environment happy-dom

// Guards the §2.4 contract that the frontend reader anchors annotations against the
// exact same block enumeration the backend generates them against. The backend
// authority is packages/tailoring `extractBlocks`; the frontend consumer is
// `applyAnnotationMarks`. Both are fed the identical node fragment HTML here so a
// future divergence (the historical "empty separator counted on one side only" /
// "nested list text counted on one side only" bugs) fails this test instead of
// silently misplacing a live annotation.

import { extractBlocks } from '@readtailor/tailoring';
import { describe, expect, it } from 'vitest';
import { applyAnnotationMarks } from './content';

function fragment(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function annotate(
  fragmentHtml: string,
  blockIndex: number,
  start: number,
  end: number,
): DocumentFragment {
  return fragment(applyAnnotationMarks(fragmentHtml, [{
    id: 'note-1',
    range: {
      start: { blockIndex, offset: start },
      end: { blockIndex, offset: end },
    },
    content: '解释',
  }]));
}

describe('front/back block enumeration consistency', () => {
  it('excludes an empty separator div on both sides so later indexes stay aligned', () => {
    const html = '<p>第一段落</p><div data-role="separator"></div><p>第二段落文本</p>';

    // Backend authority: the empty separator is not a block, so the second paragraph is block 2.
    expect(extractBlocks(html).map((block) => [block.block_index, block.text])).toEqual([
      [1, '第一段落'],
      [2, '第二段落文本'],
    ]);

    // Frontend must resolve backend block index 2 to the second paragraph, not drift by
    // one onto the separator (which historically was counted here but not by the backend).
    const rendered = annotate(html, 2, 0, 4);
    const mark = rendered.querySelector<HTMLElement>('[data-annotation-id="note-1"]');
    expect(mark?.textContent).toBe('第二段落');
    const paragraphs = rendered.querySelectorAll('p');
    expect(paragraphs[0]?.querySelector('mark')).toBeNull();
    expect(paragraphs[1]?.querySelector('mark')).not.toBeNull();
  });

  it('skips nested-list text in the outer li projection on both sides', () => {
    const html = '<ul><li>入口<ul><li>子项</li></ul>尾随文本</li></ul>';

    // Backend authority: the outer li projects "入口尾随文本" (nested list excluded); the
    // nested li is its own block.
    expect(extractBlocks(html).map((block) => [block.block_index, block.text])).toEqual([
      [1, '入口尾随文本'],
      [2, '子项'],
    ]);

    // Offsets 2..6 select "尾随文本" in backend projection coordinates. The frontend must
    // land the mark on that trailing run only, never swallowing the nested list "子项".
    const rendered = annotate(html, 1, 2, 6);
    const mark = rendered.querySelector<HTMLElement>('[data-annotation-id="note-1"]');
    expect(mark?.textContent).toBe('尾随文本');
    expect(mark?.textContent).not.toContain('子项');
    expect(rendered.querySelector('ul ul')?.querySelector('mark')).toBeNull();
  });

  it('agrees on a role div that carries text and on inline media guards', () => {
    const html = '<div data-role="unit">独立单元</div><p>说明<img src="assets/x.png" alt=""></p>';

    expect(extractBlocks(html).map((block) => [block.block_index, block.text])).toEqual([
      [1, '独立单元'],
      [2, '说明'],
    ]);

    const rendered = annotate(html, 1, 0, 4);
    expect(rendered.querySelector<HTMLElement>('[data-annotation-id="note-1"]')?.textContent)
      .toBe('独立单元');
  });
});
