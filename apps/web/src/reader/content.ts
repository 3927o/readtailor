import type { Highlight, ReaderNode, ReaderOutlineItem } from './api';
import type { TailoredAnnotation, TextRange } from '../user-books/api';
import {
  quoteFromBlocks,
  validateCanonicalBlocks,
  validateCanonicalBlocksAgainstManifestNode,
  type CanonicalReadingBlock,
} from '@readtailor/reader-core';

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
  let parent = item.parentSectionId ? byId.get(item.parentSectionId) : undefined;
  while (parent && parents.length < 8) {
    parents.push(parent);
    parent = parent.parentSectionId ? byId.get(parent.parentSectionId) : undefined;
  }
  return parents;
}

function headingVisualLevel(
  item: ReaderOutlineItem,
  byId: Map<string, ReaderOutlineItem>,
): RenderedHeading['visualLevel'] {
  if (item.dataType === 'part') return 'part';
  const levels: RenderedHeading['visualLevel'][] = ['chapter', 'section', 'subsection', 'deep'];
  const depth = parentChain(item, byId).filter((parent) => parent.dataType !== 'part').length;
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

export function readerBlockText(root: HTMLElement): string {
  // Mirror packages/tailoring textProjection exactly so client snapshots use the same UTF-16
  // coordinates the API validates: <br> is a newline and nested lists inside an <li> are skipped.
  const skipNestedLists = root.tagName === 'LI';
  const pieces: string[] = [];
  const visit = (node: Node, isRoot: boolean): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      pieces.push((node as Text).data);
      return;
    }
    if (skipNestedLists && !isRoot && node instanceof HTMLElement
      && (node.tagName === 'UL' || node.tagName === 'OL')) {
      return;
    }
    if (node instanceof HTMLBRElement) {
      pieces.push('\n');
      return;
    }
    for (const child of [...node.childNodes]) visit(child, false);
  };
  visit(root, true);
  return pieces.join('').replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

export function readerBlockLength(root: HTMLElement): number {
  return readerBlockText(root).length;
}

export function extractCanonicalBlocksFromDom(root: HTMLElement): CanonicalReadingBlock[] {
  const blocks = readingBlocks(root).map((element, index) => {
    const text = readerBlockText(element);
    const kind = element.tagName === 'DIV'
      ? `div:${element.dataset.role ?? 'unknown'}`
      : element.tagName.toLowerCase();
    return {
      blockIndex: index + 1,
      kind,
      text,
      utf16Length: text.length,
    };
  });
  validateCanonicalBlocks(blocks);
  return blocks;
}

export function quoteForReaderRange(root: HTMLElement, range: TextRange): string {
  try {
    return quoteFromBlocks(extractCanonicalBlocksFromDom(root), range);
  } catch {
    return '';
  }
}

// The ordered block elements of a live reading-node content root, using the same v1 enumeration
// as annotation anchoring (reading_contract §2.4). Block N is `readingBlocks(root)[N - 1]` — the
// reader renders each node from prepareFragment without data-block-index, so index is positional,
// matching applyAnnotationMarks' `blocks[blockIndex - 1]` fallback. Used by position save/restore
// (§11.5) and, later, selection→range for highlights (§11.7).
export function readingBlocks(root: HTMLElement): HTMLElement[] {
  return annotationBlocks(root);
}

// The block a DOM point belongs to, walking the caret node UP toward the root and returning the
// first ancestor that is itself a reading block (§11.5, reader_position_restore_fix §3.1). This is
// deliberately NOT `blocks.find(b => b.contains(node))`: blocks enumerate in document order, so an
// ancestor block (an outer <li>, or a <figure>) precedes its descendant block and a forward
// `contains` scan would bind the position to the ancestor. A nested <li>, a <figcaption>, or an
// inline element inside a <p> therefore resolves to its own innermost block, keeping the saved
// offset in the same text-projection coordinate system the backend used to enumerate it.
export function readingBlockForDomPoint(blocks: HTMLElement[], node: Node): HTMLElement | null {
  const members = new Set(blocks);
  let current: Node | null = node;
  while (current) {
    if (current instanceof HTMLElement && members.has(current)) return current;
    current = current.parentNode;
  }
  return null;
}

// Projection length (in the boundaryAt coordinate system) of a descendant subtree — used to skip
// over children that sit before a DOM position when folding it back to a block offset. Mirrors
// projectionLength / boundaryAt: <br> = 1, a nested list inside an <li> is its own block (skipped).
function subtreeProjection(node: Node, skipNestedLists: boolean): number {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.length;
  if (skipNestedLists && node instanceof HTMLElement && (node.tagName === 'UL' || node.tagName === 'OL')) return 0;
  if (node instanceof HTMLBRElement) return 1;
  let total = 0;
  for (const child of node.childNodes) total += subtreeProjection(child, skipNestedLists);
  return total;
}

// Inverse of boundaryAt: fold a DOM position (container + domOffset) inside `block` back to its
// UTF-16 offset in the block's standard text (reading_contract §2.5). MUST mirror boundaryAt /
// projectionLength exactly (<br> = one char, nested list inside an <li> skipped) so a saved anchor
// round-trips to the same character it was read at. Returns a clamped offset; never throws.
export function offsetWithinBlock(block: HTMLElement, container: Node, domOffset: number): number {
  const skipNestedLists = block.tagName === 'LI';
  let count = 0;
  let result: number | null = null;
  const walk = (node: Node, isRoot: boolean): boolean => {
    if (result !== null) return true;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      if (node === container) {
        result = count + Math.min(Math.max(domOffset, 0), text.data.length);
        return true;
      }
      count += text.data.length;
      return false;
    }
    if (skipNestedLists && !isRoot && node instanceof HTMLElement && (node.tagName === 'UL' || node.tagName === 'OL')) {
      if (node === container) { result = count; return true; }
      return false;
    }
    if (node instanceof HTMLBRElement) {
      if (node === container) { result = count + (domOffset > 0 ? 1 : 0); return true; }
      count += 1;
      return false;
    }
    // Element container: the position sits between its children at index domOffset.
    if (node === container) {
      const children = [...node.childNodes];
      for (let index = 0; index < Math.min(Math.max(domOffset, 0), children.length); index += 1) {
        count += subtreeProjection(children[index]!, skipNestedLists);
      }
      result = count;
      return true;
    }
    for (const child of [...node.childNodes]) {
      if (walk(child, false)) return true;
    }
    return false;
  };
  walk(block, true);
  return result ?? count;
}

// Forward map for restore: the DOM boundary (container + offset) of a block-relative offset, so
// the reader can build a Range and scroll it into view. Thin re-export of boundaryAt with the
// 'start' bias used for a single-point anchor.
export function domBoundaryForOffset(block: HTMLElement, offset: number): { container: Node; offset: number } | null {
  return boundaryAt(block, offset, 'start');
}

// Rebuild a live DOM Range from the persisted reader range. The end boundary deliberately uses the
// `end` bias: at an inline/text-node seam, start bias binds to the following run while end bias binds
// to the preceding run. Using start bias for both endpoints can visibly move a native selection when
// React has to restore it after an enhancement/highlight commit.
export function domRangeForReaderRange(contentRoot: HTMLElement, range: TextRange): Range | null {
  const blocks = readingBlocks(contentRoot);
  const startBlock = blocks[range.start.blockIndex - 1];
  const endBlock = blocks[range.end.blockIndex - 1];
  if (!startBlock || !endBlock) return null;
  const start = boundaryAt(startBlock, range.start.offset, 'start');
  const end = boundaryAt(endBlock, range.end.offset, 'end');
  if (!start || !end) return null;
  try {
    const domRange = window.document.createRange();
    domRange.setStart(start.container, start.offset);
    domRange.setEnd(end.container, end.offset);
    return domRange.collapsed ? null : domRange;
  } catch {
    return null;
  }
}

// Fold a DOM selection Range within one reading-node content root into a block-relative [start,end)
// range (reading_contract §2.5, §11.7) — the inverse of applyReaderMarks' forward map and the same
// coordinate system as saved positions and annotation anchors. Both endpoints must resolve to a block
// inside `contentRoot`; a selection that leaves the node, doesn't land on a block, or is collapsed
// returns null (highlights never cross a reading node). Uses readingBlockForDomPoint so an endpoint in
// a nested <li>/<figcaption>/inline element binds to its innermost block, matching the backend
// enumeration (reader_position_restore_fix §1.2) — otherwise a saved highlight would drift on reopen.
export function rangeFromSelection(contentRoot: HTMLElement, range: Range): TextRange | null {
  if (!contentRoot.contains(range.startContainer) || !contentRoot.contains(range.endContainer)) return null;
  const blocks = readingBlocks(contentRoot);
  const resolve = (container: Node, domOffset: number): { blockIndex: number; offset: number } | null => {
    const block = readingBlockForDomPoint(blocks, container);
    if (!block) return null;
    return { blockIndex: blocks.indexOf(block) + 1, offset: offsetWithinBlock(block, container, domOffset) };
  };
  const a = resolve(range.startContainer, range.startOffset);
  const b = resolve(range.endContainer, range.endOffset);
  if (!a || !b) return null;
  // A DOM Range's endpoints are already in document order, but normalize defensively; a collapsed
  // range (same block + offset) is a caret, not a highlight.
  const forward = a.blockIndex < b.blockIndex || (a.blockIndex === b.blockIndex && a.offset <= b.offset);
  const start = forward ? a : b;
  const end = forward ? b : a;
  if (start.blockIndex === end.blockIndex && start.offset === end.offset) return null;
  return { start, end };
}

// A resolved reading anchor discovered from the live DOM: which content root / block / offset the
// reading-anchor line currently sits on. `blockIndex` is 1-based (matching readingBlocks). The
// caller reads the node metadata (order / sectionId / segment) off `root`'s [data-node-order]
// ancestor so order and position always come from the same node (§2.2).
export interface ReaderDomAnchor {
  root: HTMLElement;
  block: HTMLElement;
  blockIndex: number;
  offset: number;
}

// Geometry/caret access, injected so the pure resolver in nearestReaderAnchor is testable without a
// real layout engine. Production wires these to the browser caret APIs and getBoundingClientRect;
// tests supply deterministic rects. All coordinates are viewport-relative, same frame as `anchorY`.
export interface AnchorProbe {
  caretAtPoint(x: number, y: number): { node: Node; offset: number } | null;
  // Viewport top of a collapsed range at a block boundary, or null if it cannot be measured.
  boundaryTop(boundary: { container: Node; offset: number }): number | null;
  // Viewport top/bottom of a whole block, or null if it cannot be measured.
  blockBox(block: HTMLElement): { top: number; bottom: number } | null;
}

// Within one block whose standard text is `length` chars, the offset whose boundary sits closest to
// the anchor line. Boundary tops are non-decreasing in offset (text flows down the page), so a
// binary search converges while tracking the minimal |top - anchorY| seen. Returns null only when
// no offset in the block is measurable — the caller then declines rather than fabricate a position.
function offsetNearestLine(block: HTMLElement, length: number, anchorY: number, probe: AnchorProbe): number | null {
  let lo = 0;
  let hi = length;
  let best: number | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const boundary = domBoundaryForOffset(block, mid);
    const top = boundary ? probe.boundaryTop(boundary) : null;
    if (top === null) {
      // Unmeasurable mid (e.g. a collapsed line): retreat toward the start so the search still
      // terminates on a measurable neighbour instead of spinning.
      if (mid === lo) break;
      hi = mid - 1;
      continue;
    }
    const delta = Math.abs(top - anchorY);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = mid;
    }
    if (top < anchorY) lo = mid + 1;
    else if (top > anchorY) hi = mid - 1;
    else return mid;
  }
  return best;
}

// Resolve the reading-anchor line to a concrete { root, block, blockIndex, offset } (§3.1). Order:
//   1. A precise caret hit inside a real block — the common case while reading body text.
//   2. On a miss (caret landed on a heading / guide /媒体 / inter-block gap), fall to the
//      `.reader-original` block nearest the anchor line by vertical distance.
//   3. For a text block, binary-search the offset whose character boundary is closest to the line.
//   4. For a pure media block (no projected text), offset 0 anchored at the block top.
//   5. If nothing can be measured, return null — never invent a chapter-start position.
export function nearestReaderAnchor(
  roots: HTMLElement[],
  anchorX: number,
  anchorY: number,
  probe: AnchorProbe,
): ReaderDomAnchor | null {
  const caret = probe.caretAtPoint(anchorX, anchorY);
  if (caret) {
    const root = roots.find((candidate) => candidate.contains(caret.node));
    if (root) {
      const blocks = readingBlocks(root);
      const block = readingBlockForDomPoint(blocks, caret.node);
      if (block) {
        return {
          root,
          block,
          blockIndex: blocks.indexOf(block) + 1,
          offset: offsetWithinBlock(block, caret.node, caret.offset),
        };
      }
    }
  }

  let nearest: { root: HTMLElement; block: HTMLElement; blockIndex: number; distance: number } | null = null;
  for (const root of roots) {
    const blocks = readingBlocks(root);
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      const box = probe.blockBox(block);
      if (!box) continue;
      const distance = anchorY < box.top
        ? box.top - anchorY
        : anchorY > box.bottom
          ? anchorY - box.bottom
          : 0;
      if (!nearest || distance < nearest.distance) {
        nearest = { root, block, blockIndex: index + 1, distance };
      }
    }
  }
  if (!nearest) return null;

  const length = readerBlockLength(nearest.block);
  if (length === 0) {
    return { root: nearest.root, block: nearest.block, blockIndex: nearest.blockIndex, offset: 0 };
  }
  const offset = offsetNearestLine(nearest.block, length, anchorY, probe);
  if (offset === null) return null;
  return { root: nearest.root, block: nearest.block, blockIndex: nearest.blockIndex, offset };
}

// One overlay to lay over the block text: a裁读注 anchor (green dotted underline) or a highlight
// (background). Annotations and highlights share this shape so they fold into ONE mark pass — an
// overlap of the two is split by Range.extractContents into nested <mark>s, so both styles render on
// the shared characters (§11.7 高亮与注释同段重叠).
interface MarkSpec {
  range: TextRange;
  className: string;
  dataset: Record<string, string>;
  ariaLabel: string;
}

function annotationSpec(annotation: TailoredAnnotation): MarkSpec {
  return {
    range: annotation.range,
    className: 'tailored-text-anchor',
    dataset: { annotationId: annotation.id },
    ariaLabel: '打开对应裁读注',
  };
}

function highlightSpec(highlight: Highlight): MarkSpec {
  return {
    range: highlight.range,
    className: 'reader-highlight',
    dataset: highlight.note
      ? { highlightId: highlight.id, highlightHasNote: 'true' }
      : { highlightId: highlight.id },
    ariaLabel: highlight.note ? '查看划线笔记' : '查看划线',
  };
}

function applyMarks(rawHtml: string, specs: MarkSpec[]): string {
  if (specs.length === 0) return rawHtml;
  const container = document.createElement('div');
  container.innerHTML = rawHtml;
  const blocks = annotationBlocks(container);
  const findBlock = (blockIndex: number): HTMLElement | undefined => (
    blocks.find((candidate) => Number(candidate.dataset.blockIndex) === blockIndex)
      ?? blocks[blockIndex - 1]
  );
  // Wrap last-first (descending start) so a wrap never shifts an earlier boundary. Where two marks
  // overlap, the one with the smaller start is wrapped later and its Range cuts through the mark
  // already placed; extractContents splits that mark, nesting the two — so background + underline
  // compose on the overlap regardless of which is outer.
  const ordered = [...specs].sort((left, right) => (
    right.range.start.blockIndex - left.range.start.blockIndex
    || right.range.start.offset - left.range.start.offset
  ));
  for (const spec of ordered) {
    const startBlockIndex = spec.range.start.blockIndex;
    const endBlockIndex = spec.range.end.blockIndex;
    if (endBlockIndex < startBlockIndex) continue;
    // A single inline <mark> cannot wrap across a block boundary (a <mark> is phrasing content and
    // would have to enclose the <p>…</p> break). So a range spanning blocks emits one <mark> per
    // block, all sharing the same dataset id: the first block from its start offset to the block end,
    // whole middle blocks, and the last block up to its end offset.
    for (let blockIndex = endBlockIndex; blockIndex >= startBlockIndex; blockIndex -= 1) {
      const block = findBlock(blockIndex);
      if (!block) continue;
      const parsedSourceOffset = Number(block.dataset.sourceOffset ?? 0);
      const sourceOffset = Number.isFinite(parsedSourceOffset) ? parsedSourceOffset : 0;
      const from = blockIndex === startBlockIndex ? spec.range.start.offset - sourceOffset : 0;
      const to = blockIndex === endBlockIndex
        ? spec.range.end.offset - sourceOffset
        : readerBlockLength(block);
      const start = boundaryAt(block, from, 'start');
      const end = boundaryAt(block, to, 'end');
      if (!start || !end) continue;
      const range = document.createRange();
      try {
        range.setStart(start.container, start.offset);
        range.setEnd(end.container, end.offset);
        if (range.collapsed) continue;
        const mark = document.createElement('mark');
        mark.className = spec.className;
        for (const [key, value] of Object.entries(spec.dataset)) mark.dataset[key] = value;
        mark.tabIndex = 0;
        mark.setAttribute('role', 'button');
        mark.setAttribute('aria-label', spec.ariaLabel);
        mark.append(range.extractContents());
        range.insertNode(mark);
      } catch {
        // Invalid DOM boundary should not make the original text unreadable.
      }
    }
  }
  return container.innerHTML;
}

export function applyAnnotationMarks(rawHtml: string, annotations: TailoredAnnotation[]): string {
  return applyMarks(rawHtml, annotations.map(annotationSpec));
}

// Reader mark pass: annotations + highlights in one pass so an overlap of the two nests correctly
// (§11.7). Visual nesting is decided by document position inside applyMarks, not by spec order here.
export function applyReaderMarks(
  rawHtml: string,
  annotations: TailoredAnnotation[],
  highlights: Highlight[],
): string {
  return applyMarks(rawHtml, [...annotations.map(annotationSpec), ...highlights.map(highlightSpec)]);
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
  const byId = new Map(outline.map((item) => [item.sectionId, item]));
  const depth = (item: ReaderOutlineItem): number => {
    let value = 0;
    let parent = item.parentSectionId ? byId.get(item.parentSectionId) : undefined;
    while (parent && value < 8) {
      value += 1;
      parent = parent.parentSectionId ? byId.get(parent.parentSectionId) : undefined;
    }
    return value;
  };
  const result = new Map<number, RenderedHeading[]>();
  for (const item of outline) {
    const current = result.get(item.firstNodeOrder) ?? [];
    const owner = documentRoot.getElementById(item.sectionId);
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
    result.set(item.firstNodeOrder, current);
  }
  return result;
}

export function prepareBookContent(
  rawHtml: string,
  manifestNodes: ReaderNode[],
  outline: ReaderOutlineItem[],
  assetBaseUrl: string,
  annotationsByNode: ReadonlyMap<string, TailoredAnnotation[]> = new Map(),
  highlightsByNode: ReadonlyMap<string, Highlight[]> = new Map(),
): PreparedBookContent {
  const documentRoot = new DOMParser().parseFromString(rawHtml, 'text/html');
  markNoteTopology(documentRoot);
  const headings = outlineHeadings(documentRoot, outline, assetBaseUrl);
  const nodes = manifestNodes.map((node) => {
    const owner = documentRoot.getElementById(node.sectionId);
    if (!(owner instanceof HTMLElement)) {
      throw new Error(`正文中找不到阅读节点 ${node.sectionId}`);
    }
    const segments = ownerSegments(owner);
    const segment = segments[node.segment - 1];
    if (!segment) {
      throw new Error(`阅读节点 ${node.sectionId}#${node.segment} 无法重建`);
    }
    const key = `${node.sectionId}:${node.segment}`;
    const validationRoot = documentRoot.createElement('div');
    for (const child of segment) validationRoot.append(child.cloneNode(true));
    validateCanonicalBlocksAgainstManifestNode(
      extractCanonicalBlocksFromDom(validationRoot),
      node,
    );
    return {
      ...node,
      html: applyReaderMarks(
        prepareFragment(segment, assetBaseUrl),
        annotationsByNode.get(key) ?? [],
        highlightsByNode.get(key) ?? [],
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
  const byId = new Map(outline.map((entry) => [entry.sectionId, entry]));
  let depth = 0;
  let parent = item.parentSectionId ? byId.get(item.parentSectionId) : undefined;
  while (parent && depth < 8) {
    depth += 1;
    parent = parent.parentSectionId ? byId.get(parent.parentSectionId) : undefined;
  }
  return depth;
}
