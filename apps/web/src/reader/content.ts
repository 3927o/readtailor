import type { ReaderNode, ReaderOutlineItem } from './api';
import type { TailoredAnnotation } from '../user-books/api';

const headingNames = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const mediaNames = new Set(['AUDIO', 'CANVAS', 'FIGURE', 'IMG', 'MATH', 'SVG', 'TABLE', 'VIDEO']);
const bannedNames = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK']);
const textBlockNames = new Set(['P', 'PRE', 'DT', 'DD', 'TH', 'TD']);
const mediaBlockNames = new Set(['FIGURE', 'AUDIO', 'VIDEO']);
const roleBlockNames = new Set(['separator', 'math', 'verse', 'unit', 'unknown']);

export interface RenderedNode extends ReaderNode {
  html: string;
  headings: RenderedHeading[];
}

export interface RenderedHeading extends ReaderOutlineItem {
  html: string;
  visualLevel: 'part' | 'chapter' | 'section' | 'subsection' | 'deep';
}

export interface OriginalNote {
  id: string;
  html: string;
}

export interface PreparedBookContent {
  nodes: RenderedNode[];
  notes: Map<string, OriginalNote>;
}

function isSemanticBoundary(node: ChildNode): node is HTMLElement {
  return node instanceof HTMLElement && node.tagName === 'SECTION' && node.hasAttribute('data-type');
}

function hasReadableContent(nodes: ChildNode[]): boolean {
  const container = document.createElement('div');
  for (const node of nodes) {
    container.append(node.cloneNode(true));
  }
  return Boolean(container.textContent?.trim()) || [...container.querySelectorAll('*')]
    .some((element) => mediaNames.has(element.tagName));
}

function ownerSegments(owner: HTMLElement): ChildNode[][] {
  const segments: ChildNode[][] = [];
  let pending: ChildNode[] = [];
  const flush = () => {
    if (hasReadableContent(pending)) {
      segments.push(pending);
    }
    pending = [];
  };

  for (const child of owner.childNodes) {
    if (isSemanticBoundary(child)) {
      flush();
      continue;
    }
    if (child instanceof HTMLElement && headingNames.has(child.tagName)) {
      continue;
    }
    pending.push(child);
  }
  flush();
  return segments;
}

function encodeAssetPath(path: string): string {
  return path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

export function getFragmentTargetId(href: string | null): string | null {
  if (!href?.startsWith('#') || href.length === 1) return null;
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}

function markNoteTopology(documentRoot: Document): void {
  const notes = new Map(
    [...documentRoot.querySelectorAll<HTMLElement>('[data-role="note"][id]')]
      .map((note) => [note.id, note]),
  );
  const referencedNoteIds = new Set<string>();

  for (const anchor of documentRoot.querySelectorAll<HTMLAnchorElement>('a[data-role="noteref"]')) {
    const targetId = getFragmentTargetId(anchor.getAttribute('href'));
    const target = targetId ? notes.get(targetId) : undefined;
    if (!target) {
      anchor.dataset.broken = 'true';
      anchor.setAttribute('aria-disabled', 'true');
      continue;
    }
    referencedNoteIds.add(target.id);
  }

  for (const note of notes.values()) {
    if (!referencedNoteIds.has(note.id)) {
      note.dataset.orphan = 'true';
    }
  }
}

function enhanceScrollableContent(container: HTMLElement): void {
  for (const table of [...container.querySelectorAll<HTMLTableElement>('table')]) {
    let wrapper = table.parentElement;
    if (!wrapper?.matches('[data-role="table-scroll"]')) {
      wrapper = document.createElement('div');
      wrapper.dataset.role = 'table-scroll';
      table.before(wrapper);
      wrapper.append(table);
    }
    wrapper.tabIndex = 0;
    if (!wrapper.hasAttribute('aria-label')) {
      const caption = table.querySelector('caption')?.textContent?.trim();
      wrapper.setAttribute('aria-label', caption ? `可横向滚动的表格：${caption}` : '可横向滚动的表格');
    }
  }

  for (const pre of container.querySelectorAll<HTMLElement>('pre')) {
    pre.tabIndex = 0;
    if (!pre.hasAttribute('aria-label')) {
      pre.setAttribute('aria-label', '可横向滚动的代码块');
    }
  }

  for (const math of container.querySelectorAll<HTMLElement>('div[data-role="math"]')) {
    math.tabIndex = 0;
    if (!math.hasAttribute('aria-label')) {
      math.setAttribute('aria-label', '可横向滚动的数学公式');
    }
  }
}

function parentChain(
  item: ReaderOutlineItem,
  byId: Map<string, ReaderOutlineItem>,
): ReaderOutlineItem[] {
  const parents: ReaderOutlineItem[] = [];
  let parent = item.parent_section_id ? byId.get(item.parent_section_id) : undefined;
  while (parent && parents.length < 8) {
    parents.push(parent);
    parent = parent.parent_section_id ? byId.get(parent.parent_section_id) : undefined;
  }
  return parents;
}

function headingVisualLevel(
  item: ReaderOutlineItem,
  byId: Map<string, ReaderOutlineItem>,
): RenderedHeading['visualLevel'] {
  if (item.data_type === 'part') return 'part';
  const levels: RenderedHeading['visualLevel'][] = ['chapter', 'section', 'subsection', 'deep'];
  const depth = parentChain(item, byId).filter((parent) => parent.data_type !== 'part').length;
  return levels[Math.min(depth, levels.length - 1)] ?? 'deep';
}

function prepareFragment(nodes: ChildNode[], assetBaseUrl: string): string {
  const container = document.createElement('div');
  for (const node of nodes) {
    container.append(node.cloneNode(true));
  }

  for (const element of [...container.querySelectorAll('*')]) {
    if (bannedNames.has(element.tagName)) {
      element.remove();
      continue;
    }
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith('on')) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  for (const element of container.querySelectorAll<HTMLElement>('[src], [poster]')) {
    for (const attribute of ['src', 'poster'] as const) {
      const value = element.getAttribute(attribute);
      if (value?.startsWith('assets/')) {
        element.setAttribute(attribute, `${assetBaseUrl}${encodeAssetPath(value.slice('assets/'.length))}`);
      }
    }
  }

  for (const anchor of container.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const href = anchor.getAttribute('href') ?? '';
    if (/^javascript:/i.test(href)) {
      anchor.removeAttribute('href');
    } else if (/^(https?:|mailto:|tel:)/i.test(href)) {
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
    }
  }
  enhanceScrollableContent(container);
  return container.innerHTML;
}

function directVisibleInlineContent(element: HTMLElement): boolean {
  return [...element.childNodes].some((child) => {
    if (child.nodeType === Node.TEXT_NODE) return Boolean(child.textContent?.trim());
    if (!(child instanceof HTMLElement)) return false;
    if (['UL', 'OL'].includes(child.tagName) || textBlockNames.has(child.tagName)) return false;
    return Boolean(child.textContent?.trim()) || ['IMG', 'AUDIO', 'VIDEO', 'BR'].includes(child.tagName);
  });
}

function annotationBlocks(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('*')].filter((element) => {
    if (textBlockNames.has(element.tagName)) {
      return ![...element.querySelectorAll<HTMLElement>('*')].some((nested) => (
        nested !== element && textBlockNames.has(nested.tagName)
      )) && Boolean(element.textContent?.trim());
    }
    if (element.tagName === 'LI') {
      return ![...element.children].some((child) => child.tagName === 'P') && directVisibleInlineContent(element);
    }
    if (element.tagName === 'FIGCAPTION') {
      return ![...element.children].some((child) => child.tagName === 'P') && Boolean(element.textContent?.trim());
    }
    if (mediaBlockNames.has(element.tagName)) return true;
    if (element.tagName !== 'DIV'
      || !roleBlockNames.has(element.dataset.role ?? '')
      || element.querySelector('p,pre,dt,dd,th,td,li,figcaption')) {
      return false;
    }
    // Mirror the backend block authority (packages/tailoring source.ts:93-101): a
    // role div only counts as a block when it projects visible text or carries media.
    // Without this guard an empty <div data-role="separator"> (normalized spec §4.5)
    // would be counted here but not by the backend, drifting every later block index
    // by one and silently misplacing or dropping the annotation anchor.
    return Boolean(element.textContent?.trim())
      || [...element.querySelectorAll('*')].some((nested) => mediaNames.has(nested.tagName));
  });
}

interface DomBoundary {
  container: Node;
  offset: number;
}

function boundaryAt(root: HTMLElement, targetOffset: number, bias: 'start' | 'end'): DomBoundary | null {
  // A nested list inside an <li> is its own block, so the backend text projection
  // skips it (source.ts textProjection skipNestedLists / sliceBlockHtml rootIsListItem).
  // Mirror that here, otherwise text trailing a nested list maps to a shifted offset.
  const skipNestedLists = root.tagName === 'LI';
  let cursor = 0;
  const visit = (node: Node, isRoot: boolean): DomBoundary | null => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      const length = text.data.length;
      // Half-open matching keyed on bias resolves seams between two runs of counted
      // text (e.g. a skipped nested list sitting between them): a start boundary binds
      // to the following run, an end boundary to the preceding one, so the resulting
      // range never swallows the skipped subtree.
      const hit = bias === 'start'
        ? targetOffset >= cursor && targetOffset < cursor + length
        : targetOffset > cursor && targetOffset <= cursor + length;
      if (hit) {
        return { container: text, offset: targetOffset - cursor };
      }
      cursor += length;
      return null;
    }
    if (skipNestedLists && !isRoot && node instanceof HTMLElement
      && (node.tagName === 'UL' || node.tagName === 'OL')) {
      return null;
    }
    if (node instanceof HTMLBRElement) {
      const parent = node.parentNode;
      if (!parent) return null;
      const index = [...parent.childNodes].indexOf(node);
      if (targetOffset === cursor) return { container: parent, offset: index };
      cursor += 1;
      if (targetOffset === cursor) return { container: parent, offset: index + 1 };
      return null;
    }
    for (const child of [...node.childNodes]) {
      const found = visit(child, false);
      if (found) return found;
    }
    return null;
  };
  const found = visit(root, true);
  if (found) return found;
  return targetOffset === cursor
    ? { container: root, offset: root.childNodes.length }
    : null;
}

function projectionLength(root: HTMLElement): number {
  // The projected length of a block in the same coordinates boundaryAt walks in,
  // used to locate the block's end when a cross-block annotation spans through it.
  // Mirror boundaryAt exactly: <br> counts as one char, and a nested list inside an
  // <li> is its own block so it is skipped (source.ts textProjection skipNestedLists).
  const skipNestedLists = root.tagName === 'LI';
  let count = 0;
  const visit = (node: Node, isRoot: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      count += (node as Text).data.length;
      return;
    }
    if (skipNestedLists && !isRoot && node instanceof HTMLElement
      && (node.tagName === 'UL' || node.tagName === 'OL')) {
      return;
    }
    if (node instanceof HTMLBRElement) {
      count += 1;
      return;
    }
    for (const child of [...node.childNodes]) visit(child, false);
  };
  visit(root, true);
  return count;
}

export function applyAnnotationMarks(rawHtml: string, annotations: TailoredAnnotation[]): string {
  if (annotations.length === 0) return rawHtml;
  const container = document.createElement('div');
  container.innerHTML = rawHtml;
  const blocks = annotationBlocks(container);
  const findBlock = (blockIndex: number): HTMLElement | undefined => (
    blocks.find((candidate) => Number(candidate.dataset.blockIndex) === blockIndex)
      ?? blocks[blockIndex - 1]
  );
  const ordered = [...annotations].sort((left, right) => (
    right.range.start.blockIndex - left.range.start.blockIndex
    || right.range.start.offset - left.range.start.offset
  ));
  for (const annotation of ordered) {
    const startBlockIndex = annotation.range.start.blockIndex;
    const endBlockIndex = annotation.range.end.blockIndex;
    if (endBlockIndex < startBlockIndex) continue;
    // A single inline <mark> cannot wrap across a block boundary (a <mark> is phrasing
    // content and would have to enclose the <p>…</p> break). So an annotation spanning
    // blocks emits one <mark> per block, all sharing annotation.id: the first block from
    // its start offset to the block end, whole middle blocks, and the last block up to
    // its end offset. Walk blocks last-first so a wrap never shifts an earlier boundary.
    for (let blockIndex = endBlockIndex; blockIndex >= startBlockIndex; blockIndex -= 1) {
      const block = findBlock(blockIndex);
      if (!block) continue;
      const parsedSourceOffset = Number(block.dataset.sourceOffset ?? 0);
      const sourceOffset = Number.isFinite(parsedSourceOffset) ? parsedSourceOffset : 0;
      const from = blockIndex === startBlockIndex ? annotation.range.start.offset - sourceOffset : 0;
      const to = blockIndex === endBlockIndex
        ? annotation.range.end.offset - sourceOffset
        : projectionLength(block);
      const start = boundaryAt(block, from, 'start');
      const end = boundaryAt(block, to, 'end');
      if (!start || !end) continue;
      const range = document.createRange();
      try {
        range.setStart(start.container, start.offset);
        range.setEnd(end.container, end.offset);
        if (range.collapsed) continue;
        const mark = document.createElement('mark');
        mark.className = 'tailored-text-anchor';
        mark.dataset.annotationId = annotation.id;
        mark.tabIndex = 0;
        mark.setAttribute('role', 'button');
        mark.setAttribute('aria-label', '打开对应裁读注');
        mark.append(range.extractContents());
        range.insertNode(mark);
      } catch {
        // Invalid DOM boundary should not make the original text unreadable.
      }
    }
  }
  return container.innerHTML;
}

export function prepareStandaloneContent(
  rawHtml: string,
  assetBaseUrl: string,
  annotations: TailoredAnnotation[] = [],
): string {
  const documentRoot = new DOMParser().parseFromString(`<main id="rt-standalone">${rawHtml}</main>`, 'text/html');
  const root = documentRoot.getElementById('rt-standalone');
  return root ? applyAnnotationMarks(prepareFragment([...root.childNodes], assetBaseUrl), annotations) : '';
}

function outlineHeadings(
  documentRoot: Document,
  outline: ReaderOutlineItem[],
  assetBaseUrl: string,
): Map<number, RenderedHeading[]> {
  const byId = new Map(outline.map((item) => [item.section_id, item]));
  const depth = (item: ReaderOutlineItem): number => {
    let value = 0;
    let parent = item.parent_section_id ? byId.get(item.parent_section_id) : undefined;
    while (parent && value < 8) {
      value += 1;
      parent = parent.parent_section_id ? byId.get(parent.parent_section_id) : undefined;
    }
    return value;
  };
  const result = new Map<number, RenderedHeading[]>();
  for (const item of outline) {
    const current = result.get(item.first_node_order) ?? [];
    const owner = documentRoot.getElementById(item.section_id);
    const sourceHeading = owner instanceof HTMLElement
      ? [...owner.children].find((child) => headingNames.has(child.tagName))
      : undefined;
    current.push({
      ...item,
      visualLevel: headingVisualLevel(item, byId),
      html: sourceHeading
        ? prepareFragment([...sourceHeading.childNodes], assetBaseUrl)
        : prepareFragment([documentRoot.createTextNode(item.title)], assetBaseUrl),
    });
    current.sort((left, right) => depth(left) - depth(right));
    result.set(item.first_node_order, current);
  }
  return result;
}

export function prepareBookContent(
  rawHtml: string,
  manifestNodes: ReaderNode[],
  outline: ReaderOutlineItem[],
  assetBaseUrl: string,
  annotationsByNode: ReadonlyMap<string, TailoredAnnotation[]> = new Map(),
): PreparedBookContent {
  const documentRoot = new DOMParser().parseFromString(rawHtml, 'text/html');
  markNoteTopology(documentRoot);
  const headings = outlineHeadings(documentRoot, outline, assetBaseUrl);
  const nodes = manifestNodes.map((node) => {
    const owner = documentRoot.getElementById(node.section_id);
    if (!(owner instanceof HTMLElement)) {
      throw new Error(`正文中找不到阅读节点 ${node.section_id}`);
    }
    const segments = ownerSegments(owner);
    const segment = segments[node.segment - 1];
    if (!segment) {
      throw new Error(`阅读节点 ${node.section_id}#${node.segment} 无法重建`);
    }
    return {
      ...node,
      html: applyAnnotationMarks(
        prepareFragment(segment, assetBaseUrl),
        annotationsByNode.get(`${node.section_id}:${node.segment}`) ?? [],
      ),
      headings: headings.get(node.order) ?? [],
    };
  });

  const notes = new Map<string, OriginalNote>();
  for (const note of documentRoot.querySelectorAll<HTMLElement>('[data-role="note"][id]')) {
    notes.set(note.id, {
      id: note.id,
      html: prepareFragment([...note.childNodes], assetBaseUrl),
    });
  }
  return { nodes, notes };
}

export function getOutlineDepth(item: ReaderOutlineItem, outline: ReaderOutlineItem[]): number {
  const byId = new Map(outline.map((entry) => [entry.section_id, entry]));
  let depth = 0;
  let parent = item.parent_section_id ? byId.get(item.parent_section_id) : undefined;
  while (parent && depth < 8) {
    depth += 1;
    parent = parent.parent_section_id ? byId.get(parent.parent_section_id) : undefined;
  }
  return depth;
}
