import { describe, expect, it } from 'vitest';
import { ReadingSessionTracker, localDay, localWeekStart, type SessionTrackerConfig } from './session';

// Deterministic tracker: sequential interval ids, a fixed day, small thresholds for readable timelines.
function makeTracker(overrides: Partial<SessionTrackerConfig> = {}): ReadingSessionTracker {
  let n = 0;
  return new ReadingSessionTracker({
    idleThresholdMs: 3000,
    forwardWindowMs: 5000,
    maxTickMs: 15_000,
    newIntervalId: () => `iv-${(n += 1)}`,
    dayOf: () => '2026-07-14',
    isoOf: (ms: number) => new Date(ms).toISOString(),
    ...overrides,
  });
}

describe('ReadingSessionTracker — effective time (§11.8)', () => {
  it('accrues while active and stops after the idle threshold, without back-filling the gap', () => {
    const t = makeTracker();
    t.setVisible(true);
    t.setInReader(true);
    t.initOrder(1);

    t.recordActivity(0);
    expect(t.tick(0)).toBe(true); // opens the interval, elapsed 0
    t.recordActivity(1000);
    expect(t.tick(1000)).toBe(true); // +1s
    t.recordActivity(2000);
    expect(t.tick(2000)).toBe(true); // +1s → 2s

    // No more activity after t=2000. The trailing idle-threshold grace credits up to t=5000...
    expect(t.tick(5000)).toBe(true); // 5000-2000=3000 ≤ idle → still active, +3s → 5s
    // ...then sustained inactivity pauses; the 5-minute gap is never counted.
    expect(t.tick(6000)).toBe(false);
    expect(t.tick(305_000)).toBe(false);

    expect(t.snapshot(305_000)?.effectiveSeconds).toBe(5);
  });

  it('does not accrue while the page is hidden or the reader is closed', () => {
    const t = makeTracker();
    t.setInReader(true);
    t.setVisible(false); // backgrounded
    t.recordActivity(0);
    expect(t.tick(0)).toBe(false);
    expect(t.snapshot(0)).toBeNull(); // no interval ever opened

    t.setVisible(true);
    t.setInReader(false); // in a global page, not the reader
    t.recordActivity(1000);
    expect(t.tick(1000)).toBe(false);

    t.setInReader(true);
    t.recordActivity(2000);
    expect(t.tick(2000)).toBe(true); // both conditions met → active
    expect(t.snapshot(2000)?.effectiveSeconds).toBe(0); // first credited tick has 0 elapsed
    t.recordActivity(3000);
    expect(t.tick(3000)).toBe(true);
    expect(t.snapshot(3000)?.effectiveSeconds).toBe(1);
  });
});

describe('ReadingSessionTracker — forward chars (§11.10 分子)', () => {
  const counts: Record<number, number> = { 1: 100, 2: 200, 3: 300, 4: 400 };
  const charCountFor = (order: number) => counts[order] ?? 0;

  it('credits each original node crossed by forward scroll, and nothing for a TOC jump', () => {
    const t = makeTracker();
    t.setVisible(true);
    t.setInReader(true);
    t.initOrder(1);
    t.tick(0);

    t.recordOrder(1000, 2, charCountFor, false); // 1→2 scroll: credit node 1 (100)
    t.recordOrder(2000, 3, charCountFor, false); // 2→3 scroll: credit node 2 (200) → 300
    t.recordOrder(3000, 1, charCountFor, true); // jump back to 1: no credit, frontier stays 3
    t.recordOrder(4000, 3, charCountFor, true); // jump forward to 3: no credit (didn't read the middle)

    expect(t.snapshot(5000)?.forwardChars).toBe(300);
  });

  it('does not re-credit a node when scrolling back over already-crossed ground', () => {
    const t = makeTracker();
    t.setVisible(true);
    t.setInReader(true);
    t.initOrder(1);
    t.tick(0);

    t.recordOrder(1000, 3, charCountFor, false); // forward to 3: credit nodes 1+2 (300), frontier=3
    t.recordOrder(2000, 2, charCountFor, false); // scroll back to 2: no credit (≤ frontier)
    t.recordOrder(3000, 3, charCountFor, false); // forward again to 3: still ≤ frontier, no re-credit

    expect(t.snapshot(4000)?.forwardChars).toBe(300);
  });
});

describe('ReadingSessionTracker — forward time (§11.10 分母)', () => {
  it('accrues only at the frontier with a recent forward scroll; dwelling drops out of the denominator', () => {
    const t = makeTracker({ forwardWindowMs: 2000 });
    t.setVisible(true);
    t.setInReader(true);
    t.initOrder(1);

    t.recordActivity(0, true); // forward scroll
    t.tick(0); // open, elapsed 0
    t.recordActivity(1000, true); // forward scroll
    t.tick(1000); // forward: 1000-1000=0 ≤ window → +1s forward
    // Dwell (only non-forward pointer activity) past the forward window.
    t.recordActivity(2000, false);
    t.tick(2000); // forward: 2000-1000=1000 ≤ 2000 → +1s → 2s forward
    t.recordActivity(3000, false);
    t.tick(3000); // forward: 3000-1000=2000 ≤ 2000 → +1s → 3s forward
    t.recordActivity(4000, false);
    t.tick(4000); // forward: 4000-1000=3000 > 2000 → NO; effective still +1s

    const s = t.snapshot(4000)!;
    expect(s.forwardSeconds).toBe(3);
    expect(s.effectiveSeconds).toBe(4); // all four ticks counted as effective
  });

  it('does not accrue forward time while re-reading behind the frontier', () => {
    const t = makeTracker({ forwardWindowMs: 5000 });
    t.setVisible(true);
    t.setInReader(true);
    t.initOrder(1);

    t.recordOrder(0, 3, () => 0, false); // forward to frontier 3 (forward activity at t=0)
    t.tick(0);
    t.recordOrder(1000, 2, () => 0, false); // scroll back to 2 (re-reading, below frontier)
    t.recordActivity(2000, false);
    t.tick(2000); // recent forward scroll, but currentOrder 2 < frontier 3 → not forward
    t.recordActivity(3000, false);
    t.tick(3000);

    const s = t.snapshot(3000)!;
    expect(s.forwardSeconds).toBe(0);
    expect(s.effectiveSeconds).toBeGreaterThan(0); // still effective reading time
  });
});

describe('ReadingSessionTracker — interval lifecycle & snapshot', () => {
  it('opens a fresh interval id after the previous one ends', () => {
    const t = makeTracker();
    t.setVisible(true);
    t.setInReader(true);
    t.initOrder(1);

    t.recordActivity(0);
    t.tick(0);
    const first = t.snapshot(0)!;
    expect(first.clientIntervalId).toBe('iv-1');
    expect(first.day).toBe('2026-07-14');
    expect(first.startedAt).toBe(new Date(0).toISOString());

    t.endInterval();
    expect(t.snapshot(0)).toBeNull();

    t.recordActivity(60_000);
    t.tick(60_000);
    const second = t.snapshot(60_000)!;
    expect(second.clientIntervalId).toBe('iv-2');
    expect(second.effectiveSeconds).toBe(0); // counters reset for the new interval
  });

  it('rounds cumulative milliseconds to whole seconds', () => {
    const t = makeTracker();
    t.setVisible(true);
    t.setInReader(true);
    t.initOrder(1);
    t.recordActivity(0);
    t.tick(0);
    t.recordActivity(1500);
    t.tick(1500); // +1500ms
    expect(t.snapshot(1500)?.effectiveSeconds).toBe(2); // round(1500/1000)=2
  });
});

describe('local day helpers', () => {
  it('formats a local day and a Monday week-start as YYYY-MM-DD', () => {
    const now = Date.now();
    expect(localDay(now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(localWeekStart(now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // The week start is on or before today.
    expect(localWeekStart(now) <= localDay(now)).toBe(true);
  });
});
