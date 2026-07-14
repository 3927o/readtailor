import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from './markdown';

describe('parseInline', () => {
  it('parses bold, italic and code runs', () => {
    expect(parseInline('a **b** c *d* e `f`')).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'strong', children: [{ type: 'text', value: 'b' }] },
      { type: 'text', value: ' c ' },
      { type: 'em', children: [{ type: 'text', value: 'd' }] },
      { type: 'text', value: ' e ' },
      { type: 'code', value: 'f' },
    ]);
  });

  it('prefers bold over italic for double asterisks', () => {
    expect(parseInline('**前置轻引导**——正文')).toEqual([
      { type: 'strong', children: [{ type: 'text', value: '前置轻引导' }] },
      { type: 'text', value: '——正文' },
    ]);
  });

  it('nests inline markers inside bold', () => {
    expect(parseInline('**a `b`**')).toEqual([
      { type: 'strong', children: [
        { type: 'text', value: 'a ' },
        { type: 'code', value: 'b' },
      ] },
    ]);
  });

  it('leaves an unmatched marker as literal text', () => {
    expect(parseInline('2 * 3 = 6 and **oops')).toEqual([
      { type: 'text', value: '2 * 3 = 6 and **oops' },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('splits blank-line separated blocks into paragraphs', () => {
    const blocks = parseMarkdown('第一段\n\n第二段');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
  });

  it('recognises a tight bullet list', () => {
    const [block] = parseMarkdown('- 一\n- 二');
    expect(block).toEqual({
      type: 'list',
      ordered: false,
      items: [
        [{ type: 'text', value: '一' }],
        [{ type: 'text', value: '二' }],
      ],
    });
  });

  it('recognises a tight numbered list', () => {
    const [block] = parseMarkdown('1. 一\n2. 二');
    expect(block).toEqual({
      type: 'list',
      ordered: true,
      items: [
        [{ type: 'text', value: '一' }],
        [{ type: 'text', value: '二' }],
      ],
    });
  });

  it('parses a heading and its inline markers', () => {
    expect(parseMarkdown('## 小 **标题**')).toEqual([
      { type: 'heading', level: 2, content: [
        { type: 'text', value: '小 ' },
        { type: 'strong', children: [{ type: 'text', value: '标题' }] },
      ] },
    ]);
  });

  it('keeps a blank-line-separated numbered item as a paragraph with its number', () => {
    // Loose lists (the shape the strategy summary uses) stay paragraphs so their literal
    // numbering survives; only the inline `**bold**` is upgraded.
    const [block] = parseMarkdown('1. **前置轻引导**——正文');
    expect(block).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', value: '1. ' },
        { type: 'strong', children: [{ type: 'text', value: '前置轻引导' }] },
        { type: 'text', value: '——正文' },
      ],
    });
  });

  it('does not treat a mixed block as a list', () => {
    const block = parseMarkdown('引子\n- 一\n- 二')[0]!;
    expect(block.type).toBe('paragraph');
  });
});
