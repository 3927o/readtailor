// §11.8 / §11.10 — the effective-reading accumulator. It owns one "interval" (a contiguous active
// period, §11.8) at a time and buckets three quantities the server later trusts verbatim:
//   • effectiveSeconds — all active reading time (原文 + 导读 + 注释 + 助读). Accrues while the reader is
//     in the formal reader, the page is foreground-visible, and there was activity within the idle
//     threshold. A short reading pause under that threshold still counts (§11.8「近期存在活动」); only
//     sustained inactivity / backgrounding pauses the clock, and idle time is never back-filled.
//   • forwardSeconds / forwardChars — the §11.10 speed 分母/分子. Only 正常向前读原文 accrues them: time
//     accrues while at the reading frontier (not re-reading behind it) with a recent forward scroll;
//     chars accrue as monotonic forward scrolling crosses original-text nodes. Re-reading, TOC jumps,
//     dwelling motionless, and reading 注释/导读/助读 count toward effective but NOT forward.
//
// The class is pure and timeline-driven: every method takes an explicit `nowMs`, so a scripted
// sequence of ticks/events reproduces any real session deterministically (see session.test.ts). The
// React hook (ReaderPage) is the only impure part — it forwards DOM events, a 1s tick, and page
// visibility, and flushes snapshots to the heartbeat endpoint. Idempotency (a retry never
// double-counts) is guaranteed server-side by the clientIntervalId GREATEST clamp, so the client is
// free to resend the current cumulative snapshot at will.

export interface HeartbeatPayload {
  clientIntervalId: string;
  effectiveSeconds: number;
  forwardSeconds: number;
  forwardChars: number;
  day: string;
  startedAt: string;
  at: string;
}

export interface SessionTrackerConfig {
  // Sustained inactivity beyond this pauses the interval (§11.8 空闲阈值 — an implementation param).
  idleThresholdMs?: number;
  // A forward scroll keeps forward-time eligible for this long; dwelling past it stops forward accrual.
  forwardWindowMs?: number;
  // Cap a single tick's credit so a throttled/background timer that fires late can't dump a huge delta.
  maxTickMs?: number;
  newIntervalId?: () => string;
  dayOf?: (ms: number) => string;
  isoOf?: (ms: number) => string;
}

function randomIntervalId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `iv-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// Local natural day 'YYYY-MM-DD' (§10 开放问题 3: 取浏览器时区). Exported so the stats fetch computes the
// same day/weekStart boundaries the heartbeat rolls into.
export function localDay(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Monday of the local week containing `ms`, as 'YYYY-MM-DD'. The global-stats 本周 window is
// [weekStart, today]. getDay(): 0=Sun..6=Sat → days back to Monday.
export function localWeekStart(ms: number): string {
  const d = new Date(ms);
  const dow = d.getDay();
  const backToMonday = (dow + 6) % 7;
  d.setDate(d.getDate() - backToMonday);
  return localDay(d.getTime());
}

export class ReadingSessionTracker {
  private readonly idleThresholdMs: number;
  private readonly forwardWindowMs: number;
  private readonly maxTickMs: number;
  private readonly newIntervalId: () => string;
  private readonly dayOf: (ms: number) => string;
  private readonly isoOf: (ms: number) => string;

  private intervalId: string | null = null;
  private day = '';
  private startedAtIso = '';
  private effectiveMs = 0;
  private forwardMs = 0;
  private forwardChars = 0;
  private lastTickMs: number | null = null;
  private lastActivityMs = 0;
  private lastForwardMs = 0;
  private pageVisible = true;
  private inReader = true;
  private currentOrder: number | null = null;
  private frontier = 0;

  constructor(config: SessionTrackerConfig = {}) {
    this.idleThresholdMs = config.idleThresholdMs ?? 30_000;
    this.forwardWindowMs = config.forwardWindowMs ?? 5_000;
    this.maxTickMs = config.maxTickMs ?? 15_000;
    this.newIntervalId = config.newIntervalId ?? randomIntervalId;
    this.dayOf = config.dayOf ?? localDay;
    this.isoOf = config.isoOf ?? ((ms: number) => new Date(ms).toISOString());
  }

  hasOpenInterval(): boolean {
    return this.intervalId !== null;
  }

  setVisible(visible: boolean): void {
    this.pageVisible = visible;
  }

  setInReader(inReader: boolean): void {
    this.inReader = inReader;
  }

  // The reader's starting node (resume order): both the current node and the forward frontier, so
  // reading onward is forward and nothing before the resume point is (re)credited.
  initOrder(order: number): void {
    this.currentOrder = order;
    this.frontier = Math.max(this.frontier, order);
  }

  // Any user activity (scroll / pointer / key / touch). `forward` marks a forward scroll, which is the
  // only kind that keeps forward-time eligible.
  recordActivity(nowMs: number, forward = false): void {
    this.lastActivityMs = nowMs;
    if (forward) this.lastForwardMs = nowMs;
  }

  // The reader's current node changed. `viaJump` = a TOC/anchor jump: never credits skipped chars and
  // isn't forward reading (§11.10 目录大跳不算读完中间). A forward scroll credits every original-text
  // node crossed beyond the frontier and advances the frontier.
  recordOrder(nowMs: number, newOrder: number, charCountFor: (order: number) => number, viaJump: boolean): void {
    const prev = this.currentOrder;
    if (viaJump) {
      this.frontier = Math.max(this.frontier, newOrder);
      this.currentOrder = newOrder;
      this.recordActivity(nowMs, false);
      return;
    }
    if (newOrder > this.frontier) {
      for (let order = this.frontier; order < newOrder; order += 1) {
        this.forwardChars += Math.max(0, charCountFor(order));
      }
      this.frontier = newOrder;
    }
    this.currentOrder = newOrder;
    this.recordActivity(nowMs, prev !== null && newOrder > prev);
  }

  private isActive(nowMs: number): boolean {
    return this.pageVisible && this.inReader && nowMs - this.lastActivityMs <= this.idleThresholdMs;
  }

  private ensureInterval(nowMs: number): void {
    if (this.intervalId !== null) return;
    this.intervalId = this.newIntervalId();
    this.day = this.dayOf(nowMs);
    this.startedAtIso = this.isoOf(nowMs);
    this.effectiveMs = 0;
    this.forwardMs = 0;
    this.forwardChars = 0;
    this.lastTickMs = nowMs;
    // Don't imply a forward scroll just because an interval opened — forward accrues only after a real
    // forward event lands within the window.
    this.lastForwardMs = 0;
  }

  // The periodic accountant (call at a steady cadence, e.g. 1s). Advances time, starts an interval on
  // activity, and accrues effective/forward time. Returns whether the interval is currently active so
  // the caller can flush + end on the active→idle edge. Never accrues idle/background time.
  tick(nowMs: number): boolean {
    const active = this.isActive(nowMs);
    if (active) this.ensureInterval(nowMs);
    const elapsed = this.lastTickMs === null ? 0 : Math.min(Math.max(0, nowMs - this.lastTickMs), this.maxTickMs);
    this.lastTickMs = nowMs;
    if (active && this.intervalId !== null) {
      this.effectiveMs += elapsed;
      const atFrontier = this.currentOrder === null || this.currentOrder >= this.frontier;
      const recentForward = nowMs - this.lastForwardMs <= this.forwardWindowMs;
      if (atFrontier && recentForward) this.forwardMs += elapsed;
    }
    return active;
  }

  // The cumulative heartbeat for the open interval (null if none). `at` is this observation's time; the
  // counters are cumulative, so resending is safe (server clamps by GREATEST).
  snapshot(nowMs: number): HeartbeatPayload | null {
    if (this.intervalId === null) return null;
    return {
      clientIntervalId: this.intervalId,
      effectiveSeconds: Math.round(this.effectiveMs / 1000),
      forwardSeconds: Math.round(this.forwardMs / 1000),
      forwardChars: Math.round(this.forwardChars),
      day: this.day,
      startedAt: this.startedAtIso,
      at: this.isoOf(nowMs),
    };
  }

  // End the current interval. The next active tick opens a fresh one with a new id. Snapshot first if
  // the final values still need flushing.
  endInterval(): void {
    this.intervalId = null;
  }
}
