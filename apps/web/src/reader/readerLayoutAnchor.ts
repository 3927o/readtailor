import { useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { ReaderPosition } from './api';
import { domBoundaryForOffset, readerBlockLength, readingBlocks } from './content';

export type ReaderLogicalPosition = Pick<
  ReaderPosition,
  'sectionId' | 'segment' | 'blockIndex' | 'offset'
>;

export type ReaderAnchorTarget =
  | { kind: 'position'; position: ReaderLogicalPosition }
  | { kind: 'block'; sectionId: string; segment: number; blockIndex: number }
  | { kind: 'node'; sectionId: string; segment: number };

export interface ResolvedReaderAnchorTarget {
  element: HTMLElement;
  boundary: { container: Node; offset: number } | null;
}

export interface ReaderAnchorGeometry {
  boundaryTop(boundary: { container: Node; offset: number }): number | null;
  elementTop(element: HTMLElement): number | null;
}

export interface ReaderLayoutAnchorSnapshot {
  position: ReaderLogicalPosition;
  viewportTop: number;
  scrollTop: number;
}

export type ReaderScrollPhase = 'restoring' | 'settled' | 'cancelled' | 'normal';

interface ReaderLayoutAnchorOptions {
  root: RefObject<HTMLElement | null>;
  version: string;
  getPosition(): ReaderLogicalPosition | null;
  getPhase(): ReaderScrollPhase;
  geometry?: ReaderAnchorGeometry;
}

function readerNodeFor(
  root: HTMLElement,
  sectionId: string,
  segment: number,
): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>('[data-section-id][data-segment]')].find((node) => (
    node.dataset.sectionId === sectionId && Number(node.dataset.segment) === segment
  )) ?? null;
}

export function resolveReaderAnchorTarget(
  root: HTMLElement,
  target: ReaderAnchorTarget,
): ResolvedReaderAnchorTarget | null {
  const sectionId = target.kind === 'position' ? target.position.sectionId : target.sectionId;
  const segment = target.kind === 'position' ? target.position.segment : target.segment;
  const node = readerNodeFor(root, sectionId, segment);
  if (!node) return null;
  if (target.kind === 'node') return { element: node, boundary: null };

  const contentRoot = node.querySelector<HTMLElement>('.reader-original');
  if (!contentRoot) return null;
  const blockIndex = target.kind === 'position' ? target.position.blockIndex : target.blockIndex;
  const block = readingBlocks(contentRoot)[blockIndex - 1];
  if (!block) return null;
  if (target.kind === 'block') return { element: block, boundary: null };

  const boundary = domBoundaryForOffset(block, target.position.offset);
  if (boundary) return { element: block, boundary };
  if (target.position.offset === 0 && readerBlockLength(block) === 0) {
    return { element: block, boundary: null };
  }
  return null;
}

const browserGeometry: ReaderAnchorGeometry = {
  boundaryTop(boundary) {
    try {
      const range = window.document.createRange();
      range.setStart(boundary.container, boundary.offset);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      if (rect.top === 0 && rect.bottom === 0 && rect.height === 0 && rect.width === 0) return null;
      return rect.top;
    } catch {
      return null;
    }
  },
  elementTop(element) {
    const rect = element.getBoundingClientRect();
    if (rect.top === 0 && rect.bottom === 0 && rect.height === 0 && rect.width === 0) return null;
    return rect.top;
  },
};

export function measureReaderAnchorViewportTop(
  root: HTMLElement,
  target: ReaderAnchorTarget,
  geometry: ReaderAnchorGeometry = browserGeometry,
  fallbackToElement = true,
): number | null {
  const resolved = resolveReaderAnchorTarget(root, target);
  if (!resolved) return null;
  if (resolved.boundary) {
    const boundaryTop = geometry.boundaryTop(resolved.boundary);
    return boundaryTop ?? (fallbackToElement ? geometry.elementTop(resolved.element) : null);
  }
  return geometry.elementTop(resolved.element);
}

export function captureReaderLayoutAnchor(
  root: HTMLElement,
  position: ReaderLogicalPosition,
  geometry?: ReaderAnchorGeometry,
): ReaderLayoutAnchorSnapshot | null {
  const viewportTop = measureReaderAnchorViewportTop(root, { kind: 'position', position }, geometry, false);
  return viewportTop === null ? null : { position, viewportTop, scrollTop: root.scrollTop };
}

export function compensateReaderLayoutAnchor(
  root: HTMLElement,
  snapshot: ReaderLayoutAnchorSnapshot,
  phase: ReaderScrollPhase,
  geometry?: ReaderAnchorGeometry,
): number | null {
  if (phase === 'restoring') return null;
  if (Math.abs(root.scrollTop - snapshot.scrollTop) > 0.5) return null;
  const viewportTop = measureReaderAnchorViewportTop(
    root,
    { kind: 'position', position: snapshot.position },
    geometry,
    false,
  );
  if (viewportTop === null) return null;
  const delta = viewportTop - snapshot.viewportTop;
  root.scrollTop += delta;
  return delta;
}

export function useReaderLayoutAnchor(options: ReaderLayoutAnchorOptions): void {
  const committedVersion = useRef<string | null>(null);
  const pendingAnchor = useRef<ReaderLayoutAnchorSnapshot | null>(null);

  if (options.version !== committedVersion.current && pendingAnchor.current === null) {
    const root = options.root.current;
    const position = options.getPosition();
    if (root && position) {
      pendingAnchor.current = captureReaderLayoutAnchor(root, position, options.geometry);
    }
  }

  useLayoutEffect(() => {
    committedVersion.current = options.version;
    const snapshot = pendingAnchor.current;
    pendingAnchor.current = null;
    const root = options.root.current;
    if (!root || !snapshot) return;
    compensateReaderLayoutAnchor(root, snapshot, options.getPhase(), options.geometry);
  }, [options.version]);
}
