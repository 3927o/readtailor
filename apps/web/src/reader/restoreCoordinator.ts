// §2.4 / §3 restore coordinator — a short-lived, interruptible state machine that pins a saved
// character boundary to the reading-anchor line through first-paint layout drift (remote fonts,
// late-sized images, streamed enhancement blocks), then hands scroll control back. It is NOT a
// persistent service or component; it runs once per open and stops within a bounded window.
//
// It is the SINGLE scroll writer while active (`restoring`): the layout-anchor must only observe, or
// two mechanisms would each compensate the same shift and double it. All DOM/clock access is injected
// so the machine is unit-testable without a real layout engine or rAF (see restoreCoordinator.test.ts).

export type RestorePhase = 'idle' | 'restoring' | 'settled' | 'cancelled';

export interface RestoreCoordinatorDeps {
  now(): number;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  getScrollTop(): number;
  setScrollTop(value: number): void;
  // Current top of the saved boundary, measured relative to the scroll container's top edge (same
  // frame of reference as `anchorTop`). Returns null when it cannot be measured this frame (content
  // not yet laid out) — such a frame never counts toward stability.
  measureTop(): number | null;
  // The line the boundary is pinned to (READING_ANCHOR_TOP).
  anchorTop: number;
  // Called exactly once, when the machine settles (never on cancel), to report the final anchor.
  onSettle(): void;
  // Longest the machine may hold scroll control (default 1500ms) — a hard cap so a never-stabilizing
  // layout can't pin the scroll forever.
  maxDurationMs?: number;
  // Movement under this many px counts as "no movement" for the stability check (default 0.5).
  epsilon?: number;
  // Consecutive still frames (with assets ready) required to settle early (default 2).
  stableFramesToSettle?: number;
}

export interface RestoreCoordinator {
  // Begin pinning. The first correction is synchronous (instant restore, no animation frame delay),
  // then a per-frame maintenance loop keeps the boundary on the anchor line.
  start(): void;
  // Mark fonts + known preceding images as loaded; only then may the machine settle early.
  markAssetsReady(): void;
  // User took over (wheel / touch / pointer / nav key). Stops immediately with no final correction or
  // report; the user's own scroll flows through the normal save path.
  cancel(): void;
  phase(): RestorePhase;
}

export function createRestoreCoordinator(deps: RestoreCoordinatorDeps): RestoreCoordinator {
  const maxDurationMs = deps.maxDurationMs ?? 1500;
  const epsilon = deps.epsilon ?? 0.5;
  const stableFramesToSettle = deps.stableFramesToSettle ?? 2;

  let phase: RestorePhase = 'idle';
  let startedAt = 0;
  let stableFrames = 0;
  let assetsReady = false;
  let frame: number | null = null;

  const stop = (next: 'settled' | 'cancelled'): void => {
    if (frame !== null) {
      deps.cancelFrame(frame);
      frame = null;
    }
    phase = next;
    if (next === 'settled') deps.onSettle();
  };

  // Re-measure the boundary and compensate any drift back onto the anchor line. Tracks stability as a
  // side effect: a still frame increments `stableFrames`, any movement (or an unmeasurable frame)
  // resets it.
  const correct = (): void => {
    const top = deps.measureTop();
    if (top === null) {
      stableFrames = 0;
      return;
    }
    const delta = top - deps.anchorTop;
    if (Math.abs(delta) > epsilon) {
      deps.setScrollTop(deps.getScrollTop() + delta);
      stableFrames = 0;
    } else {
      stableFrames += 1;
    }
  };

  // One per-frame maintenance pass: correct, then decide whether to keep pinning or settle.
  const tick = (): void => {
    frame = null;
    if (phase !== 'restoring') return;
    correct();
    if (deps.now() - startedAt >= maxDurationMs) {
      stop('settled');
      return;
    }
    if (assetsReady && stableFrames >= stableFramesToSettle) {
      stop('settled');
      return;
    }
    frame = deps.requestFrame(tick);
  };

  return {
    start() {
      if (phase !== 'idle') return;
      phase = 'restoring';
      startedAt = deps.now();
      // Instant restore: place the boundary synchronously so there is no one-frame flash. This
      // placement does not count toward stability — the maintenance loop judges that over the frames
      // that follow.
      correct();
      stableFrames = 0;
      frame = deps.requestFrame(tick);
    },
    markAssetsReady() {
      assetsReady = true;
    },
    cancel() {
      if (phase !== 'restoring') return;
      stop('cancelled');
    },
    phase() {
      return phase;
    },
  };
}
