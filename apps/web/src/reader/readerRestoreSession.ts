import { useLayoutEffect, useRef } from 'react';
import { createRestoreCoordinator } from './restoreCoordinator';
import type { ReaderScrollPhase } from './readerLayoutAnchor';

interface RestoreScheduler {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
}

export interface ReaderRestoreSessionOptions {
  root: HTMLElement;
  anchorTop: number;
  measureTop(): number | null;
  targetElement(): HTMLElement | null;
  onPhaseChange(phase: Exclude<ReaderScrollPhase, 'normal'>): void;
  onScrollWrite?(scrollTop: number): void;
  onSettle(): void;
  scheduler?: RestoreScheduler;
}

export function isRestoreScrollEvent(expectedScrollTop: number | null, actualScrollTop: number): boolean {
  return expectedScrollTop !== null && Math.abs(actualScrollTop - expectedScrollTop) <= 0.5;
}

export function startReaderRestoreSession(options: ReaderRestoreSessionOptions): () => void {
  const { root } = options;
  const scheduler = options.scheduler ?? {
    now: () => performance.now(),
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  };
  const previousScrollBehavior = root.style.scrollBehavior;
  root.style.scrollBehavior = 'auto';

  let tornDown = false;
  const cleanups: Array<() => void> = [];
  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    root.style.scrollBehavior = previousScrollBehavior;
    for (const cleanup of cleanups) cleanup();
  };

  const coordinator = createRestoreCoordinator({
    now: scheduler.now,
    requestFrame: scheduler.requestFrame,
    cancelFrame: scheduler.cancelFrame,
    getScrollTop: () => root.scrollTop,
    setScrollTop: (value) => {
      root.scrollTop = value;
      options.onScrollWrite?.(root.scrollTop);
    },
    measureTop: options.measureTop,
    anchorTop: options.anchorTop,
    onSettle: () => {
      options.onPhaseChange('settled');
      options.onSettle();
      teardown();
    },
  });
  cleanups.push(() => coordinator.cancel());

  const cancelToUser = () => {
    if (coordinator.phase() !== 'restoring') return;
    coordinator.cancel();
    options.onPhaseChange('cancelled');
    teardown();
  };
  const navKeys = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Spacebar']);
  const onKey = (event: KeyboardEvent) => { if (navKeys.has(event.key)) cancelToUser(); };
  for (const type of ['wheel', 'touchstart', 'pointerdown'] as const) {
    root.addEventListener(type, cancelToUser, { passive: true });
    cleanups.push(() => root.removeEventListener(type, cancelToUser));
  }
  window.addEventListener('keydown', onKey);
  cleanups.push(() => window.removeEventListener('keydown', onKey));

  let fontsReady = false;
  let pendingImages = 0;
  const maybeReady = () => {
    if (!tornDown && fontsReady && pendingImages === 0) coordinator.markAssetsReady();
  };
  const targetElement = options.targetElement();
  const precedingImages = targetElement
    ? [...root.querySelectorAll<HTMLImageElement>('img')].filter((image) => (
        !image.complete
        && (targetElement.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
      ))
    : [];
  pendingImages = precedingImages.length;
  for (const image of precedingImages) {
    const done = () => { pendingImages = Math.max(0, pendingImages - 1); maybeReady(); };
    image.addEventListener('load', done, { once: true });
    image.addEventListener('error', done, { once: true });
    cleanups.push(() => {
      image.removeEventListener('load', done);
      image.removeEventListener('error', done);
    });
  }
  const fonts = window.document.fonts;
  if (fonts?.ready) {
    fonts.ready.then(() => { fontsReady = true; maybeReady(); }).catch(() => {});
  } else {
    fontsReady = true;
  }
  maybeReady();

  options.onPhaseChange('restoring');
  coordinator.start();
  return () => {
    if (coordinator.phase() === 'restoring') {
      coordinator.cancel();
      options.onPhaseChange('cancelled');
    }
    teardown();
  };
}

export function useReaderRestoreLifecycle(setup: () => void | (() => void)): void {
  const setupRef = useRef(setup);
  setupRef.current = setup;
  useLayoutEffect(() => setupRef.current(), []);
}
