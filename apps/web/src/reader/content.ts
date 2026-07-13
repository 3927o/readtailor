import type { ReaderNode, ReaderOutlineItem } from './api';

const headingNames = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const mediaNames = new Set(['AUDIO', 'CANVAS', 'FIGURE', 'IMG', 'SVG', 'TABLE', 'VIDEO']);
const bannedNames = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK']);

export interface RenderedNode extends ReaderNode {
  html: string;
  headings: ReaderOutlineItem[];
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
  return container.innerHTML;
}

function outlineHeadings(outline: ReaderOutlineItem[]): Map<number, ReaderOutlineItem[]> {
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
  const result = new Map<number, ReaderOutlineItem[]>();
  for (const item of outline) {
    const current = result.get(item.first_node_order) ?? [];
    current.push(item);
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
): PreparedBookContent {
  const documentRoot = new DOMParser().parseFromString(rawHtml, 'text/html');
  const headings = outlineHeadings(outline);
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
      html: prepareFragment(segment, assetBaseUrl),
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
