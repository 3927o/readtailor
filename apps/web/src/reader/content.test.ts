// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';
import type { ReaderNode, ReaderOutlineItem } from './api';
import { applyAnnotationMarks, getFragmentTargetId, prepareBookContent } from './content';

function fragment(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function readerNode(sectionId: string): ReaderNode {
  return {
    section_id: sectionId,
    segment: 1,
    order: 1,
    region: 'bodymatter',
    data_type: 'chapter',
    title: '第一章',
    parent_section_id: null,
    character_count: 2,
    block_count: 1,
  };
}

describe('prepareBookContent', () => {
  it('maps UTF-16 annotation offsets across inline elements without rewriting text', () => {
    const html = applyAnnotationMarks('<p>甲😀<strong>关键</strong>乙</p>', [{
      id: 'note-1',
      range: {
        start: { blockIndex: 1, offset: 1 },
        end: { blockIndex: 1, offset: 5 },
      },
      content: '解释',
    }]);
    const rendered = fragment(html);
    const mark = rendered.querySelector<HTMLElement>('[data-annotation-id="note-1"]');

    expect(mark?.textContent).toBe('😀关键');
    expect(mark?.querySelector('strong')?.textContent).toBe('关键');
    expect(rendered.textContent).toBe('甲😀关键乙');
  });

  it('maps annotations in a partial block from source offsets to local DOM offsets', () => {
    const html = applyAnnotationMarks(
      '<p data-block-index="3" data-source-offset="4">甲😀关键乙</p>',
      [{
        id: 'note-partial',
        range: {
          start: { blockIndex: 3, offset: 5 },
          end: { blockIndex: 3, offset: 9 },
        },
        content: '解释',
      }],
    );
    const rendered = fragment(html);
    const mark = rendered.querySelector<HTMLElement>('[data-annotation-id="note-partial"]');

    expect(mark?.textContent).toBe('😀关键');
    expect(rendered.textContent).toBe('甲😀关键乙');
  });

  it('uses stable block indexes when a fragment starts after source block one', () => {
    const html = applyAnnotationMarks(
      '<p data-block-index="2" data-source-offset="0">第二块</p><p data-block-index="3" data-source-offset="0">第三块内容</p>',
      [{
        id: 'note-third-block',
        range: {
          start: { blockIndex: 3, offset: 0 },
          end: { blockIndex: 3, offset: 3 },
        },
        content: '解释',
      }],
    );
    const rendered = fragment(html);
    const mark = rendered.querySelector<HTMLElement>('[data-annotation-id="note-third-block"]');

    expect(mark?.textContent).toBe('第三块');
    expect(rendered.querySelector('[data-block-index="2"] mark')).toBeNull();
  });

  it('spans a two-block annotation with one mark per block sharing the id', () => {
    const html = applyAnnotationMarks('<p>第一段结尾</p><p>第二段开头</p>', [{
      id: 'note-span',
      range: {
        start: { blockIndex: 1, offset: 3 },
        end: { blockIndex: 2, offset: 3 },
      },
      content: '解释',
    }]);
    const rendered = fragment(html);
    const marks = rendered.querySelectorAll<HTMLElement>('[data-annotation-id="note-span"]');
    const paragraphs = rendered.querySelectorAll('p');

    expect(marks).toHaveLength(2);
    expect(paragraphs[0]?.querySelector('mark')?.textContent).toBe('结尾');
    expect(paragraphs[1]?.querySelector('mark')?.textContent).toBe('第二段');
    expect(rendered.textContent).toBe('第一段结尾第二段开头');
  });

  it('wraps whole middle blocks when an annotation spans three blocks', () => {
    const html = applyAnnotationMarks('<p>首块尾</p><p>整块</p><p>末块头</p>', [{
      id: 'note-three',
      range: {
        start: { blockIndex: 1, offset: 2 },
        end: { blockIndex: 3, offset: 1 },
      },
      content: '解释',
    }]);
    const rendered = fragment(html);
    const marks = rendered.querySelectorAll<HTMLElement>('[data-annotation-id="note-three"]');
    const paragraphs = rendered.querySelectorAll('p');

    expect(marks).toHaveLength(3);
    expect(paragraphs[0]?.querySelector('mark')?.textContent).toBe('尾');
    expect(paragraphs[1]?.querySelector('mark')?.textContent).toBe('整块');
    expect(paragraphs[2]?.querySelector('mark')?.textContent).toBe('末');
    expect(rendered.textContent).toBe('首块尾整块末块头');
  });

  it('preserves rich heading and note semantics while enhancing scrollable content', () => {
    const rawHtml = `<!doctype html><html lang="zh-CN"><body><main id="book" data-type="book">
      <section id="bodymatter" data-role="bodymatter">
        <section id="chapter-1" data-type="chapter">
          <h1><em>第一章</em><a data-role="noteref" href="#note-0001">1</a></h1>
          <p>正文<img src="assets/inline mark.png" alt="标记"></p>
          <table data-role="table" id="table-1"><caption>数据</caption><tbody><tr><th scope="row">甲</th><td colspan="2">乙</td></tr></tbody></table>
          <div data-role="table-scroll" aria-label="已有表格"><table id="table-2"><tbody><tr><td>丙</td></tr></tbody></table></div>
          <pre><code>const value = 1;</code></pre>
        </section>
      </section>
      <section id="notes" data-role="notes">
        <div id="note-0001" data-role="note"><p><strong>注释</strong></p><ol><li>条目</li></ol><table id="note-table"><tbody><tr><td>值</td></tr></tbody></table></div>
      </section>
    </main></body></html>`;
    const outline: ReaderOutlineItem[] = [{
      section_id: 'chapter-1',
      data_type: 'chapter',
      title: '第一章',
      parent_section_id: null,
      first_node_order: 1,
    }];

    const prepared = prepareBookContent(rawHtml, [readerNode('chapter-1')], outline, '/books/1/assets/');
    const renderedNode = prepared.nodes[0];
    const renderedHeading = renderedNode?.headings[0];
    if (!renderedNode || !renderedHeading) throw new Error('expected rendered chapter content');
    const body = fragment(renderedNode.html);
    const heading = fragment(renderedHeading.html);
    const note = fragment(prepared.notes.get('note-0001')?.html ?? '');

    expect(heading.querySelector('em')?.textContent).toBe('第一章');
    expect(heading.querySelector('[data-role="noteref"]')?.getAttribute('href')).toBe('#note-0001');
    expect(body.querySelector('h1')).toBeNull();
    expect(body.querySelector('img')?.getAttribute('src')).toBe('/books/1/assets/inline%20mark.png');

    const bodyWrappers = body.querySelectorAll('[data-role="table-scroll"]');
    expect(bodyWrappers).toHaveLength(2);
    const firstWrapper = bodyWrappers.item(0);
    const secondWrapper = bodyWrappers.item(1);
    expect(firstWrapper.getAttribute('tabindex')).toBe('0');
    expect(firstWrapper.getAttribute('aria-label')).toContain('数据');
    expect(firstWrapper.querySelector(':scope > table#table-1')).not.toBeNull();
    expect(firstWrapper.querySelector('th')?.getAttribute('scope')).toBe('row');
    expect(firstWrapper.querySelector('td')?.getAttribute('colspan')).toBe('2');
    expect(secondWrapper.getAttribute('aria-label')).toBe('已有表格');
    expect(secondWrapper.querySelectorAll('[data-role="table-scroll"]')).toHaveLength(0);
    expect(body.querySelector('pre')?.getAttribute('tabindex')).toBe('0');

    expect(note.querySelector('strong')?.textContent).toBe('注释');
    expect(note.querySelector('ol li')?.textContent).toBe('条目');
    expect(note.querySelector('[data-role="table-scroll"] > table#note-table')).not.toBeNull();
  });

  it('maps non-part headings by outline depth instead of their type name', () => {
    const rawHtml = `<!doctype html><html lang="zh-CN"><body><main id="book" data-type="book">
      <section id="bodymatter" data-role="bodymatter">
        <section id="part-1" data-type="part"><h1>第一部</h1>
          <section id="appendix-1" data-type="appendix"><h2>附录</h2>
            <section id="preface-1" data-type="preface"><h3>说明</h3><p>正文</p></section>
          </section>
        </section>
      </section>
    </main></body></html>`;
    const outline: ReaderOutlineItem[] = [
      { section_id: 'part-1', data_type: 'part', title: '第一部', parent_section_id: null, first_node_order: 1 },
      { section_id: 'appendix-1', data_type: 'appendix', title: '附录', parent_section_id: 'part-1', first_node_order: 1 },
      { section_id: 'preface-1', data_type: 'preface', title: '说明', parent_section_id: 'appendix-1', first_node_order: 1 },
    ];

    const prepared = prepareBookContent(rawHtml, [readerNode('preface-1')], outline, '/assets/');
    const renderedNode = prepared.nodes[0];
    if (!renderedNode) throw new Error('expected rendered nested content');

    expect(renderedNode.headings.map((heading) => heading.visualLevel)).toEqual([
      'part',
      'chapter',
      'section',
    ]);
  });

  it('marks unresolved noterefs as broken without creating an empty note', () => {
    const rawHtml = `<!doctype html><html lang="zh-CN"><body><main id="book" data-type="book">
      <section id="bodymatter" data-role="bodymatter">
        <section id="chapter-1" data-type="chapter"><h1>第一章</h1><p>正文<a data-role="noteref" href="#missing-note">9</a></p></section>
      </section>
    </main></body></html>`;
    const outline: ReaderOutlineItem[] = [{
      section_id: 'chapter-1',
      data_type: 'chapter',
      title: '第一章',
      parent_section_id: null,
      first_node_order: 1,
    }];

    const prepared = prepareBookContent(rawHtml, [readerNode('chapter-1')], outline, '/assets/');
    const renderedNode = prepared.nodes[0];
    if (!renderedNode) throw new Error('expected rendered chapter content');
    const body = fragment(renderedNode.html);
    const noteref = body.querySelector('[data-role="noteref"]');

    expect(noteref?.textContent).toBe('9');
    expect(noteref?.getAttribute('href')).toBe('#missing-note');
    expect(noteref?.getAttribute('data-broken')).toBe('true');
    expect(noteref?.getAttribute('aria-disabled')).toBe('true');
    expect(prepared.notes.has('missing-note')).toBe(false);
    expect(getFragmentTargetId('#note%20one')).toBe('note one');
  });
});
