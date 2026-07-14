// §5.2: the restore coordinator is a pure state machine over injected rect/clock/rAF, so its
// behaviour is testable without a browser. Each test drives frames by hand: `measureTop` is an
// oracle the test moves to simulate first-paint drift, and a single frame is ever scheduled at a
// time (each tick schedules the next), so `frame()` deterministically advances the loop.

import { describe, expect, it } from 'vitest';
import { createRestoreCoordinator, type RestoreCoordinatorDeps } from './restoreCoordinator';

const ANCHOR = 96;

function makeHarness(initialTop: number | null) {
  let time = 0;
  let scrollTop = 0;
  let top = initialTop;
  let nextHandle = 1;
  let scheduled: { handle: number; run: () => void } | null = null;
  let settleCount = 0;

  const deps: RestoreCoordinatorDeps = {
    now: () => time,
    requestFrame: (callback) => {
      const handle = nextHandle;
      nextHandle += 1;
      scheduled = { handle, run: callback };
      return handle;
    },
    cancelFrame: (handle) => {
      if (scheduled?.handle === handle) scheduled = null;
    },
    getScrollTop: () => scrollTop,
    setScrollTop: (value) => {
      scrollTop = value;
    },
    measureTop: () => top,
    anchorTop: ANCHOR,
    onSettle: () => {
      settleCount += 1;
    },
    maxDurationMs: 1500,
    epsilon: 0.5,
    stableFramesToSettle: 2,
  };

  return {
    deps,
    setTop: (value: number | null) => { top = value; },
    advance: (ms: number) => { time += ms; },
    frame: () => {
      const current = scheduled;
      scheduled = null;
      current?.run();
    },
    hasFrame: () => scheduled !== null,
    scrollTop: () => scrollTop,
    settleCount: () => settleCount,
  };
}

describe('restore coordinator', () => {
  it('corrects the boundary to the anchor line synchronously on start (instant restore)', () => {
    const h = makeHarness(200); // boundary sits 200px down; anchor is 96
    const coordinator = createRestoreCoordinator(h.deps);
    coordinator.start();
    // No animation frame needed for the first correction: scrolled by 200 - 96 = 104 immediately.
    expect(h.scrollTop()).toBe(104);
    expect(coordinator.phase()).toBe('restoring');
    expect(h.hasFrame()).toBe(true);
  });

  it('re-pins the boundary after a late reflow pushes it off the anchor line', () => {
    const h = makeHarness(ANCHOR); // already on the line
    const coordinator = createRestoreCoordinator(h.deps);
    coordinator.start();
    expect(h.scrollTop()).toBe(0); // nothing to correct yet
    // A font/image above the boundary loads and shifts it down 40px.
    h.setTop(ANCHOR + 40);
    h.advance(16);
    h.frame();
    expect(h.scrollTop()).toBe(40); // compensated exactly once
    // Boundary now back on the line; with assets ready it settles after two still frames.
    h.setTop(ANCHOR);
    coordinator.markAssetsReady();
    h.advance(16); h.frame();
    h.advance(16); h.frame();
    expect(coordinator.phase()).toBe('settled');
    expect(h.settleCount()).toBe(1);
  });

  it('reports the final anchor exactly once, and only after settling', () => {
    const h = makeHarness(ANCHOR);
    const coordinator = createRestoreCoordinator(h.deps);
    coordinator.start();
    coordinator.markAssetsReady();
    expect(h.settleCount()).toBe(0); // nothing reported while restoring
    h.advance(16); h.frame(); // stable frame 1
    expect(h.settleCount()).toBe(0);
    h.advance(16); h.frame(); // stable frame 2 → settle
    expect(h.settleCount()).toBe(1);
    // Any further scheduled work is a no-op — no second report.
    h.advance(16); h.frame();
    expect(h.settleCount()).toBe(1);
    expect(h.hasFrame()).toBe(false);
  });

  it('cancels immediately on user input without a final correction or report', () => {
    const h = makeHarness(300);
    const coordinator = createRestoreCoordinator(h.deps);
    coordinator.start();
    const afterStart = h.scrollTop();
    coordinator.cancel();
    expect(coordinator.phase()).toBe('cancelled');
    expect(h.settleCount()).toBe(0);
    expect(h.hasFrame()).toBe(false);
    // A stray frame after cancel must not move the scroll or settle.
    h.setTop(500);
    h.frame();
    expect(h.scrollTop()).toBe(afterStart);
    expect(coordinator.phase()).toBe('cancelled');
  });

  it('does not settle early until assets are ready, however still the layout is', () => {
    const h = makeHarness(ANCHOR);
    const coordinator = createRestoreCoordinator(h.deps);
    coordinator.start();
    for (let i = 0; i < 5; i += 1) { h.advance(16); h.frame(); }
    expect(coordinator.phase()).toBe('restoring'); // stable but assets not ready
    coordinator.markAssetsReady();
    h.advance(16); h.frame();
    h.advance(16); h.frame();
    expect(coordinator.phase()).toBe('settled');
  });

  it('treats an unmeasurable frame as movement, not stability', () => {
    const h = makeHarness(ANCHOR);
    const coordinator = createRestoreCoordinator(h.deps);
    coordinator.start();
    coordinator.markAssetsReady();
    h.advance(16); h.frame(); // stable 1
    h.setTop(null); // content briefly unmeasurable → resets stability
    h.advance(16); h.frame();
    expect(coordinator.phase()).toBe('restoring');
    h.setTop(ANCHOR);
    h.advance(16); h.frame(); // stable 1 again
    h.advance(16); h.frame(); // stable 2 → settle
    expect(coordinator.phase()).toBe('settled');
  });

  it('settles at the hard time cap even if the layout never stabilizes', () => {
    const h = makeHarness(200);
    const coordinator = createRestoreCoordinator(h.deps);
    coordinator.start();
    coordinator.markAssetsReady();
    // Keep the boundary moving so stability never triggers.
    for (let elapsed = 16; elapsed < 1500; elapsed += 16) {
      h.setTop(200 + elapsed); // always off the line
      h.advance(16);
      h.frame();
      expect(coordinator.phase()).toBe('restoring');
    }
    h.advance(16); // now past 1500ms
    h.frame();
    expect(coordinator.phase()).toBe('settled');
    expect(h.settleCount()).toBe(1);
  });
});
