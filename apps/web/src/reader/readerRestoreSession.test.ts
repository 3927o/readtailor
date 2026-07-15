// @vitest-environment happy-dom

import { act, createElement, StrictMode, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import {
  isRestoreScrollEvent,
  startReaderRestoreSession,
  useReaderRestoreLifecycle,
} from './readerRestoreSession';
import type { ReaderScrollPhase } from './readerLayoutAnchor';

const ANCHOR_TOP = 96;
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    hasFrame: () => frames.size > 0,
  };
}

function scrollRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.append(root);
  return root;
}

describe('reader restore session lifecycle', () => {
  it('starts normally after React StrictMode runs setup → cleanup → setup', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const reactRoot = createRoot(host);
    const clock = scheduler();
    const phases: ReaderScrollPhase[] = [];
    let top = ANCHOR_TOP;
    const mounted = { reader: null as HTMLElement | null };

    function Harness() {
      const root = useRef<HTMLDivElement>(null);
      useReaderRestoreLifecycle(() => {
        if (!root.current) return;
        mounted.reader = root.current;
        return startReaderRestoreSession({
          root: root.current,
          anchorTop: ANCHOR_TOP,
          measureTop: () => top,
          targetElement: () => root.current,
          onPhaseChange: (phase) => { phases.push(phase); },
          onSettle: () => {},
          scheduler: clock.value,
        });
      });
      return createElement('div', { ref: root });
    }

    await act(async () => {
      reactRoot.render(createElement(StrictMode, null, createElement(Harness)));
    });

    top += 40;
    clock.advance(16);
    await act(async () => { clock.frame(); });

    expect(mounted.reader?.scrollTop).toBe(40);
    expect(phases).toEqual(['restoring', 'cancelled', 'restoring']);
    await act(async () => { reactRoot.unmount(); });
    host.remove();
  });

  it('cancels immediately when the user scrolls and ignores later layout movement', () => {
    const root = scrollRoot();
    const clock = scheduler();
    const phases: ReaderScrollPhase[] = [];
    let top = 200;
    let settleCount = 0;
    const cleanup = startReaderRestoreSession({
      root,
      anchorTop: ANCHOR_TOP,
      measureTop: () => top,
      targetElement: () => root,
      onPhaseChange: (phase) => { phases.push(phase); },
      onSettle: () => { settleCount += 1; },
      scheduler: clock.value,
    });
    const restoredScrollTop = root.scrollTop;

    top = 400;
    root.dispatchEvent(new Event('wheel'));
    expect(phases.at(-1)).toBe('cancelled');
    expect(clock.hasFrame()).toBe(false);
    clock.advance(16);
    clock.frame();
    expect(root.scrollTop).toBe(restoredScrollTop);
    expect(settleCount).toBe(0);

    cleanup();
    root.remove();
  });

  it('reports the browser-clamped scrollTop after a restore write', () => {
    const root = scrollRoot();
    const clock = scheduler();
    let scrollTop = 0;
    Object.defineProperty(root, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.max(0, Math.min(50, value)); },
    });
    let written: number | null = null;
    const cleanup = startReaderRestoreSession({
      root,
      anchorTop: ANCHOR_TOP,
      measureTop: () => 200,
      targetElement: () => root,
      onPhaseChange: () => {},
      onScrollWrite: (value) => { written = value; },
      onSettle: () => {},
      scheduler: clock.value,
    });

    expect(root.scrollTop).toBe(50);
    expect(written).toBe(50);
    expect(isRestoreScrollEvent(written, root.scrollTop)).toBe(true);
    expect(isRestoreScrollEvent(written, root.scrollTop + 1)).toBe(false);
    cleanup();
    root.remove();
  });
});
