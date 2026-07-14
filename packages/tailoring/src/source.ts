import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { TailoringError, type GenerationBlock, type TextRange } from './types';

const headingNames = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const textBlockNames = new Set(['p', 'pre', 'dt', 'dd', 'th', 'td']);
const mediaBlockNames = new Set(['figure', 'audio', 'video']);
const mediaNames = new Set(['audio', 'canvas', 'figure', 'img', 'math', 'svg', 'table', 'video']);
const roleBlocks = new Set(['separator', 'math', 'verse', 'unit', 'unknown']);

export interface ExtractedNodeSource {
  structuredHtml: string;
  blocks: GenerationBlock[];
  originalNotes: Array<{ id: string; html: string }>;
}

function isElement(node: AnyNode): node is Element {
  return node.type === 'tag';
}

function isBoundary($: CheerioAPI, node: AnyNode): boolean {
  return isElement(node) && node.tagName === 'section' && Boolean($(node).attr('data-type'));
}

function textProjection($: CheerioAPI, root: Element, skipNestedLists = false): string {
  const pieces: string[] = [];
  const visit = (node: AnyNode, isRoot = false) => {
    if (node.type === 'text') {
      pieces.push(node.data);
      return;
    }
    if (!isElement(node)) return;
    if (node.tagName === 'br') {
      pieces.push('\n');
      return;
    }
    if (skipNestedLists && !isRoot && (node.tagName === 'ul' || node.tagName === 'ol')) return;
    for (const child of node.children) visit(child);
  };
  visit(root, true);
  return pieces.join('').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function hasVisibleDirectInlineContent($: CheerioAPI, element: Element): boolean {
  for (const child of element.children) {
    if (child.type === 'text' && child.data.trim()) return true;
    if (!isElement(child)) continue;
    if (child.tagName === 'ul' || child.tagName === 'ol' || textBlockNames.has(child.tagName)) continue;
    if ($(child).text().trim() || ['img', 'audio', 'video', 'br'].includes(child.tagName)) return true;
  }
  return false;
}

function blockHtml($: CheerioAPI, element: Element): string {
  return $.html(element);
}

export function extractBlocks(fragmentHtml: string): GenerationBlock[] {
  const $ = load(`<div id="rt-fragment-root">${fragmentHtml}</div>`, { xmlMode: false });
  const root = $('#rt-fragment-root');
  const blocks: GenerationBlock[] = [];
  root.find('*').each((_index, raw) => {
    if (!isElement(raw)) return;
    const element = $(raw);
    const name = raw.tagName;
    let kind: string | undefined;
    let text: string | undefined;
    if (textBlockNames.has(name)) {
      const nested = element.find([...textBlockNames].join(',')).length > 0;
      if (!nested) {
        const projected = textProjection($, raw);
        if (projected.trim()) {
          kind = name;
          text = projected;
        }
      }
    } else if (name === 'li') {
      if (element.children('p').length === 0 && hasVisibleDirectInlineContent($, raw)) {
        kind = 'li';
        text = textProjection($, raw, true);
      }
    } else if (name === 'figcaption') {
      if (element.children('p').length === 0) {
        const projected = textProjection($, raw);
        if (projected.trim()) {
          kind = 'figcaption';
          text = projected;
        }
      }
    } else if (mediaBlockNames.has(name)) {
      kind = name;
      text = '';
    } else if (name === 'div' && roleBlocks.has(element.attr('data-role') ?? '')) {
      const nestedSelector = [...textBlockNames, 'li', 'figcaption'].join(',');
      if (element.find(nestedSelector).length === 0) {
        const projected = textProjection($, raw);
        if (projected.trim() || element.find([...mediaNames].join(',')).length > 0) {
          kind = `div:${element.attr('data-role')}`;
          text = projected;
        }
      }
    }
    if (kind === undefined || text === undefined) return;
    blocks.push({ block_index: blocks.length + 1, text, html: blockHtml($, raw) });
  });
  return blocks;
}

function hasReadableContent(html: string): boolean {
  const $ = load(`<div id="rt-test-root">${html}</div>`);
  const root = $('#rt-test-root');
  return Boolean(root.text().trim()) || root.find([...mediaNames].join(',')).length > 0;
}

function ownedSegments($: CheerioAPI, owner: Cheerio<Element>): string[] {
  const segments: string[] = [];
  let pending = '';
  const flush = () => {
    const html = pending.trim();
    if (html && hasReadableContent(html)) segments.push(html);
    pending = '';
  };
  for (const child of owner.contents().toArray()) {
    if (isBoundary($, child)) {
      flush();
      continue;
    }
    if (isElement(child) && headingNames.has(child.tagName)) continue;
    pending += $.html(child);
  }
  flush();
  return segments;
}

export function extractNodeSourceFromHtml(
  rawHtml: string,
  sectionId: string,
  segment: number,
): ExtractedNodeSource {
  const $ = load(rawHtml, { xmlMode: false });
  const owner = $('section').filter((_index, element) => $(element).attr('id') === sectionId).first();
  if (owner.length === 0) {
    throw new TailoringError('invalid_input', `normalized HTML is missing section ${sectionId}`);
  }
  const structuredHtml = ownedSegments($, owner).at(segment - 1);
  if (!structuredHtml) {
    throw new TailoringError('invalid_input', `normalized HTML is missing segment ${sectionId}#${segment}`);
  }
  const fragment = load(`<div id="rt-node-fragment">${structuredHtml}</div>`);
  const referencedNoteIds = new Set(
    fragment('#rt-node-fragment a[data-role="noteref"][href^="#"]')
      .toArray()
      .map((anchor) => fragment(anchor).attr('href')?.slice(1) ?? '')
      .map((id) => {
        try {
          return decodeURIComponent(id);
        } catch {
          return id;
        }
      })
      .filter(Boolean),
  );
  const originalNotes = $('[data-role="note"][id]')
    .toArray()
    .filter((note) => referencedNoteIds.has($(note).attr('id') ?? ''))
    .map((note) => ({
      id: $(note).attr('id')!,
      html: $(note).html() ?? '',
    }));
  return { structuredHtml, blocks: extractBlocks(structuredHtml), originalNotes };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function addBlockMetadata(
  html: string,
  blockIndex: number,
  sourceOffset: number,
): string {
  const $ = load(html, { xmlMode: false }, false);
  const root = $.root().children().first();
  const rootElement = root.get(0);
  if (!rootElement || !isElement(rootElement)) {
    return `<p data-block-index="${blockIndex}" data-source-offset="${sourceOffset}">${escapeHtml(html)}</p>`;
  }
  root.attr('data-block-index', String(blockIndex));
  root.attr('data-source-offset', String(sourceOffset));
  return $.html(rootElement);
}

function sliceBlockHtml(
  block: GenerationBlock,
  start: number,
  end: number,
): string {
  const $ = load(block.html, { xmlMode: false }, false);
  const root = $.root().children().first();
  const rootElement = root.get(0);
  if (!rootElement || !isElement(rootElement)) {
    return `<p data-block-index="${block.block_index}" data-source-offset="${start}">${escapeHtml(block.text.slice(start, end))}</p>`;
  }

  let cursor = 0;
  const rootIsListItem = rootElement.tagName === 'li';
  const trim = (node: AnyNode, isRoot = false): boolean => {
    if (node.type === 'text') {
      const nodeStart = cursor;
      const nodeEnd = cursor + node.data.length;
      cursor = nodeEnd;
      const localStart = Math.max(0, start - nodeStart);
      const localEnd = Math.min(node.data.length, end - nodeStart);
      if (localStart >= localEnd) {
        $(node).remove();
        return false;
      }
      node.data = node.data.slice(localStart, localEnd);
      return true;
    }
    if (!isElement(node)) return false;
    if (rootIsListItem && !isRoot && (node.tagName === 'ul' || node.tagName === 'ol')) {
      $(node).remove();
      return false;
    }
    if (node.tagName === 'br') {
      const keep = start <= cursor && end > cursor;
      cursor += 1;
      if (!keep) $(node).remove();
      return keep;
    }

    const positionBefore = cursor;
    let keptChild = false;
    for (const child of [...node.children]) {
      keptChild = trim(child) || keptChild;
    }
    const isZeroWidthSemantic = mediaNames.has(node.tagName)
      || (node.tagName === 'a' && $(node).attr('data-role') === 'noteref');
    const keepEmpty = !keptChild
      && cursor === positionBefore
      && isZeroWidthSemantic
      && start <= cursor
      && cursor <= end;
    if (!isRoot && !keptChild && !keepEmpty) $(node).remove();
    return keptChild || keepEmpty;
  };

  trim(rootElement, true);
  root.attr('data-block-index', String(block.block_index));
  root.attr('data-source-offset', String(start));
  return $.html(rootElement);
}

export function sliceNodeSource(
  source: ExtractedNodeSource,
  range: TextRange,
): ExtractedNodeSource {
  const selected = source.blocks.filter(
    (block) => block.block_index >= range.start.block_index && block.block_index <= range.end.block_index,
  );
  if (selected.length === 0) {
    throw new TailoringError('invalid_input', 'generation range does not include any source block');
  }
  const blocks = selected.map((block) => {
    const start = block.block_index === range.start.block_index ? range.start.offset : 0;
    const end = block.block_index === range.end.block_index ? range.end.offset : block.text.length;
    const text = block.text.slice(start, end);
    const partial = start !== 0 || end !== block.text.length;
    return {
      ...block,
      text,
      source_offset: start,
      html: partial
        ? sliceBlockHtml(block, start, end)
        : addBlockMetadata(block.html, block.block_index, 0),
    };
  });
  return {
    structuredHtml: blocks.map((block) => block.html).join('\n'),
    blocks,
    originalNotes: source.originalNotes,
  };
}
