import { describe, expect, it } from 'vitest';
import { parseTailoringModelResponse } from './parser';
import { extractNodeSourceFromHtml, extractNodeTexts, sliceNodeSource } from './source';

const html = `<!doctype html><html><body><main id="book" data-type="book">
  <section id="bodymatter" data-role="bodymatter">
    <section id="chapter-1" data-type="chapter">
      <h1>第一章</h1>
      <p>甲<strong>关键</strong><br>乙<a data-role="noteref" href="#note-1"></a></p>
      <ul><li>独立条目<ul><li>嵌套条目</li></ul></li><li><p>段落条目</p></li></ul>
      <section id="section-1" data-type="section"><h2>子节</h2><p>子节正文</p></section>
      <p>父节点第二段</p>
    </section>
  </section>
  <section id="notes" data-role="notes"><div id="note-1" data-role="note"><p>原书注</p></div></section>
</main></body></html>`;

describe('normalized book source extraction', () => {
  it('rebuilds owner segments and Block v1 text projections', () => {
    const first = extractNodeSourceFromHtml(html, 'chapter-1', 1);
    const second = extractNodeSourceFromHtml(html, 'chapter-1', 2);

    expect(first.blocks.map((block) => [block.block_index, block.text])).toEqual([
      [1, '甲关键\n乙'],
      [2, '独立条目'],
      [3, '嵌套条目'],
      [4, '段落条目'],
    ]);
    expect(first.structuredHtml).not.toContain('第一章');
    expect(first.structuredHtml).not.toContain('子节正文');
    expect(second.blocks.map((block) => block.text)).toEqual(['父节点第二段']);
    expect(first.originalNotes).toEqual([{ id: 'note-1', html: '<p>原书注</p>' }]);
  });

  it('projects every node to whitespace-collapsed text keyed by (sectionId, segment)', () => {
    const texts = extractNodeTexts(html);
    const byKey = new Map(texts.map((node) => [`${node.sectionId}#${node.segment}`, node.text]));

    // Segmentation matches extractNodeSourceFromHtml: chapter-1 has two segments split by the
    // nested section boundary; headings are dropped.
    expect(byKey.get('chapter-1#1')).toContain('甲关键乙');
    expect(byKey.get('chapter-1#1')).toContain('段落条目');
    expect(byKey.get('chapter-1#1')).not.toContain('第一章');
    expect(byKey.get('chapter-1#2')).toBe('父节点第二段');
    expect(byKey.get('section-1#1')).toBe('子节正文');
  });

  it('slices a continuous trial range while retaining stable block indexes', () => {
    const source = extractNodeSourceFromHtml(html, 'chapter-1', 1);
    const sliced = sliceNodeSource(source, {
      start: { block_index: 1, offset: 1 },
      end: { block_index: 2, offset: 4 },
    });

    expect(sliced.blocks.map((block) => [block.block_index, block.text])).toEqual([
      [1, '关键\n乙'],
      [2, '独立条目'.slice(0, 4)],
    ]);
    expect(sliced.blocks.map((block) => block.source_offset)).toEqual([1, 0]);
    expect(sliced.blocks[0]?.html).toBe(
      '<p data-block-index="1" data-source-offset="1"><strong>关键</strong><br>乙<a data-role="noteref" href="#note-1"></a></p>',
    );
    expect(sliced.structuredHtml).toContain('<strong>关键</strong><br>乙');

    const result = parseTailoringModelResponse(
      JSON.stringify({
        guide: null,
        annotations: [{ block_index: 1, quote: '关键', content: '解释' }],
        after_reading: null,
      }),
      {
        user_id: 'user-1',
        package_id: 'package-1',
        package_version: 'v1',
        generation_scope: 'trial',
        fragment_range: {
          start: { block_index: 1, offset: 1 },
          end: { block_index: 2, offset: 4 },
        },
        profiles: {
          book: { version: 'book-1', value: {} },
          reader: { version: 'reader-1', value: {} },
          book_reader: { version: 'book-reader-1', value: {} },
        },
        strategy: {
          kind: 'strategy_draft',
          version: 'draft-1',
          status: 'approved_for_trial',
          value: {},
        },
        source: {
          section_id: 'chapter-1',
          segment: 1,
          node_order: 1,
          title: '第一章',
          ancestor_titles: [],
          range: {
            start: { block_index: 1, offset: 1 },
            end: { block_index: 2, offset: 4 },
          },
          structured_html: sliced.structuredHtml,
          blocks: sliced.blocks,
          original_notes: [],
          previous_context: null,
          next_context: null,
        },
        model: { model_id: 'fake', config_version: 'v1' },
      },
    );
    expect(result.annotations[0]?.range).toEqual({
      start: { block_index: 1, offset: 1 },
      end: { block_index: 1, offset: 3 },
    });
  });

  it('adds stable source indexes to complete blocks when a slice starts after block one', () => {
    const source = extractNodeSourceFromHtml(html, 'chapter-1', 1);
    const sliced = sliceNodeSource(source, {
      start: { block_index: 2, offset: 0 },
      end: { block_index: 3, offset: source.blocks[2]!.text.length },
    });

    expect(sliced.blocks.map((block) => block.block_index)).toEqual([2, 3]);
    expect(sliced.blocks[0]?.html).toContain('data-block-index="2" data-source-offset="0"');
    expect(sliced.blocks[1]?.html).toContain('data-block-index="3" data-source-offset="0"');
  });
});
