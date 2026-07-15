// @vitest-environment happy-dom

import { act, createElement, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { createRestoreCoordinator } from './restoreCoordinator';
import {
  captureReaderLayoutAnchor,
  compensateReaderLayoutAnchor,
  measureReaderAnchorViewportTop,
  resolveReaderAnchorTarget,
  useReaderLayoutAnchor,
} from './readerLayoutAnchor';
import type { ReaderAnchorGeometry, ReaderLogicalPosition, ReaderScrollPhase } from './readerLayoutAnchor';
import { startReaderRestoreSession, useReaderRestoreLifecycle } from './readerRestoreSession';

const ANCHOR_TOP = 96;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const position: ReaderLogicalPosition = {
  sectionId: 'section-1',
  segment: 1,
  blockIndex: 1,
  offset: 3,
};

function readerRoot(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = `
    <section data-node-order="1" data-section-id="section-1" data-segment="1">
      <div class="reader-original"><p>甲乙丙丁戊</p></div>
    </section>
  `;
  document.body.append(root);
  return root;
}

function geometry(
  boundaryTop: () => number,
  measuredContainers: Node[] = [],
): ReaderAnchorGeometry {
  return {
    boundaryTop(boundary) {
      measuredContainers.push(boundary.container);
      return boundaryTop();
    },
    elementTop: () => 0,
  };
}

function scheduler() {
  let time = 0;
  let nextHandle = 1;
  const frames = new Map<number, () => void>();
  return {
    value: {
      now: () => time,
      requestFrame: (callback: () => void) => {
        const handle = nextHandle;
        nextHandle += 1;
        frames.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle: number) => { frames.delete(handle); },
    },
    advance: (ms: number) => { time += ms; },
    frame: () => {
      const entry = frames.entries().next().value as [number, () => void] | undefined;
      if (!entry) return;
      frames.delete(entry[0]);
      entry[1]();
    },
  };
}

describe('reader logical layout anchor', () => {
  it('re-resolves the saved character after original DOM replacement during restore', () => {
    const root = readerRoot();
    const original = root.querySelector<HTMLElement>('.reader-original')!;
    const measuredContainers: Node[] = [];
    let top = ANCHOR_TOP;
    const frames: Array<() => void> = [];
    let scrollTop = 0;
    const coordinator = createRestoreCoordinator({
      now: () => 0,
      requestFrame: (callback) => { frames.push(callback); return 1; },
      cancelFrame: () => { frames.length = 0; },
      getScrollTop: () => scrollTop,
      setScrollTop: (value) => { scrollTop = value; },
      measureTop: () => measureReaderAnchorViewportTop(
        root,
        { kind: 'position', position },
        geometry(() => top, measuredContainers),
      ),
      anchorTop: ANCHOR_TOP,
      onSettle: () => {},
    });

    coordinator.start();
    const oldContainer = measuredContainers.at(-1)!;
    original.innerHTML = '<p>甲乙<strong>丙丁</strong>戊</p>';
    top = ANCHOR_TOP + 40;
    frames.shift()?.();

    const newContainer = measuredContainers.at(-1)!;
    expect(oldContainer.isConnected).toBe(false);
    expect(newContainer.isConnected).toBe(true);
    expect(newContainer).not.toBe(oldContainer);
    expect(scrollTop).toBe(40);
    coordinator.cancel();
    root.remove();
  });

  it('keeps the same character fixed when a guide is inserted inside the same reader node', () => {
    const root = readerRoot();
    const node = root.querySelector<HTMLElement>('[data-node-order]')!;
    const original = root.querySelector<HTMLElement>('.reader-original')!;
    let top = ANCHOR_TOP;
    const probe = geometry(() => top);
    const snapshot = captureReaderLayoutAnchor(root, position, probe)!;

    const guide = document.createElement('section');
    guide.className = 'tailored-guide reader-tailored-block';
    guide.textContent = '导读';
    node.insertBefore(guide, original);
    top += 80;

    expect(compensateReaderLayoutAnchor(root, snapshot, 'normal', probe)).toBe(80);
    expect(root.scrollTop).toBe(80);
    root.remove();
  });

  it('applies compensation instantly and reports the internal scroll destination', () => {
    const root = readerRoot();
    let top = ANCHOR_TOP;
    let scrollTop = 0;
    let behaviorDuringWrite = '';
    root.style.scrollBehavior = 'smooth';
    Object.defineProperty(root, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        behaviorDuringWrite = root.style.scrollBehavior;
        scrollTop = value;
      },
    });
    const probe = geometry(() => top);
    const snapshot = captureReaderLayoutAnchor(root, position, probe)!;
    top += 48;
    let reported: number | null = null;

    expect(compensateReaderLayoutAnchor(
      root,
      snapshot,
      'normal',
      probe,
      (value) => { reported = value; },
    )).toBe(48);
    expect(behaviorDuringWrite).toBe('auto');
    expect(root.style.scrollBehavior).toBe('smooth');
    expect(reported).toBe(48);
    root.remove();
  });

  it('compensates an enhancement commit after the real restore session settles', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const reactRoot = createRoot(host);
    const clock = scheduler();
    const phases: ReaderScrollPhase[] = [];
    const mounted = { reader: null as HTMLDivElement | null };
    const probe: ReaderAnchorGeometry = {
      boundaryTop(boundary) {
        const element = boundary.container instanceof Element
          ? boundary.container
          : boundary.container.parentElement;
        return element?.closest('[data-node-order]')?.querySelector('.tailored-guide')
          ? ANCHOR_TOP + 52
          : ANCHOR_TOP;
      },
      elementTop: () => 0,
    };

    function Harness({ enhanced }: { enhanced: boolean }) {
      const root = useRef<HTMLDivElement>(null);
      const phase = useRef<ReaderScrollPhase>('normal');
      useReaderLayoutAnchor({
        root,
        version: enhanced ? 'ready' : 'queued',
        getPosition: () => position,
        getPhase: () => phase.current,
        geometry: probe,
      });
      useReaderRestoreLifecycle(() => {
        if (!root.current) return;
        mounted.reader = root.current;
        return startReaderRestoreSession({
          root: root.current,
          anchorTop: ANCHOR_TOP,
          measureTop: () => measureReaderAnchorViewportTop(
            root.current!,
            { kind: 'position', position },
            probe,
          ),
          targetElement: () => resolveReaderAnchorTarget(
            root.current!,
            { kind: 'position', position },
          )?.element ?? null,
          onPhaseChange: (next) => { phase.current = next; phases.push(next); },
          onSettle: () => {},
          scheduler: clock.value,
        });
      });
      return createElement(
        'div',
        { ref: root },
        createElement(
          'section',
          { 'data-node-order': '1', 'data-section-id': 'section-1', 'data-segment': '1' },
          enhanced ? createElement('section', { className: 'tailored-guide' }, '导读') : null,
          createElement('div', { className: 'reader-original' }, createElement('p', null, '甲乙丙丁戊')),
        ),
      );
    }

    await act(async () => { reactRoot.render(createElement(Harness, { enhanced: false })); });
    clock.advance(16);
    await act(async () => { clock.frame(); });
    clock.advance(16);
    await act(async () => { clock.frame(); });
    expect(phases.at(-1)).toBe('settled');

    await act(async () => { reactRoot.render(createElement(Harness, { enhanced: true })); });
    expect(mounted.reader?.scrollTop).toBe(52);

    await act(async () => { reactRoot.unmount(); });
    host.remove();
  });

  it('falls back to the current block top when a collapsed boundary cannot be measured', () => {
    const root = readerRoot();
    const probe: ReaderAnchorGeometry = {
      boundaryTop: () => null,
      elementTop: () => 140,
    };

    expect(measureReaderAnchorViewportTop(root, { kind: 'position', position }, probe)).toBe(140);
    root.remove();
  });

  it('drops a stale layout snapshot after the user scrolls before commit', () => {
    const root = readerRoot();
    let top = ANCHOR_TOP;
    const probe = geometry(() => top);
    const snapshot = captureReaderLayoutAnchor(root, position, probe)!;
    root.scrollTop = 30;
    top += 50;

    expect(compensateReaderLayoutAnchor(root, snapshot, 'normal', probe)).toBeNull();
    expect(root.scrollTop).toBe(30);
    root.remove();
  });
});
