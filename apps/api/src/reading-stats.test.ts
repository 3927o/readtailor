import { describe, expect, it } from 'vitest';
import {
  computeBookProgress,
  computeStreakDays,
  resolveReadingSpeed,
  type ManifestMeta,
} from './user-books';

// §11.10 speed选择: the book's own forward-reading speed once the sample is solid and sane, else the
// language default flagged approximate. Only forward original-text time/chars feed this (分母/分子).
describe('resolveReadingSpeed', () => {
  it('uses the language default (approximate) when the sample is too small', () => {
    expect(resolveReadingSpeed('zh', 30, 200)).toEqual({ charsPerSec: 6.5, approximate: true });
    expect(resolveReadingSpeed('en-US', 30, 200)).toEqual({ charsPerSec: 18, approximate: true });
    // Unknown language falls back to the generic default.
    expect(resolveReadingSpeed('fr', 30, 200)).toEqual({ charsPerSec: 9, approximate: true });
    expect(resolveReadingSpeed(null, 0, 0)).toEqual({ charsPerSec: 9, approximate: true });
  });

  it('switches to the personal speed once both sample floors are cleared', () => {
    // 3000 chars over 300 s = 10 chars/sec, within the sane band → personal, not approximate.
    expect(resolveReadingSpeed('zh', 300, 3000)).toEqual({ charsPerSec: 10, approximate: false });
  });

  it('needs both the time and the char floor, not just one', () => {
    // Enough seconds but too few chars → still the default.
    expect(resolveReadingSpeed('zh', 300, 800).approximate).toBe(true);
    // Enough chars but too little time → still the default.
    expect(resolveReadingSpeed('zh', 60, 5000).approximate).toBe(true);
  });

  it('rejects an abnormal personal speed and keeps the default (§11.10 异常速度过滤)', () => {
    // 200 chars/sec (way past the sane ceiling) from a big-but-brief burst → default, approximate.
    expect(resolveReadingSpeed('zh', 200, 40_000)).toEqual({ charsPerSec: 6.5, approximate: true });
  });
});

// §11.9/§11.10 whole-node original-text progress from the stable position against manifest char counts.
describe('computeBookProgress', () => {
  const meta = (bookTotalChars: number | null, counts: Array<[number, number]>): ManifestMeta => ({
    version: 'v1',
    language: 'zh',
    bookTotalChars,
    charCountByOrder: new Map(counts),
    nodesByOrder: new Map(),
  });

  const book = meta(1000, [[1, 400], [2, 300], [3, 300]]);

  it('reports zero progress at the start of the book (no stored position)', () => {
    expect(computeBookProgress(book, null)).toEqual({
      totalChars: 1000,
      charsBefore: 0,
      remainingChars: 1000,
      progressPercent: 0,
    });
  });

  it('sums whole nodes strictly before the current order', () => {
    // At order 3, nodes 1+2 are behind → 700 read, 300 remaining, 70%.
    expect(computeBookProgress(book, 3)).toEqual({
      totalChars: 1000,
      charsBefore: 700,
      remainingChars: 300,
      progressPercent: 70,
    });
  });

  it('clamps to 100% and non-negative remaining past the last node', () => {
    expect(computeBookProgress(book, 99)).toEqual({
      totalChars: 1000,
      charsBefore: 1000,
      remainingChars: 0,
      progressPercent: 100,
    });
  });

  it('returns a null total when the manifest carries no char counts', () => {
    expect(computeBookProgress(meta(null, []), 2)).toEqual({
      totalChars: null,
      charsBefore: 0,
      remainingChars: 0,
      progressPercent: 0,
    });
  });
});

// §11.9 current consecutive reading streak.
describe('computeStreakDays', () => {
  it('counts a run ending today', () => {
    const days = new Set(['2026-07-12', '2026-07-13', '2026-07-14']);
    expect(computeStreakDays(days, '2026-07-14')).toBe(3);
  });

  it('does not break the streak when today has not been read yet', () => {
    // Today (07-15) absent, but 12–14 form a run ending yesterday → still counts.
    const days = new Set(['2026-07-12', '2026-07-13', '2026-07-14']);
    expect(computeStreakDays(days, '2026-07-15')).toBe(3);
  });

  it('stops at the first gap', () => {
    const days = new Set(['2026-07-10', '2026-07-13', '2026-07-14']);
    expect(computeStreakDays(days, '2026-07-14')).toBe(2);
  });

  it('crosses a month boundary correctly', () => {
    const days = new Set(['2026-06-30', '2026-07-01', '2026-07-02']);
    expect(computeStreakDays(days, '2026-07-02')).toBe(3);
  });

  it('is zero when neither today nor yesterday has reading', () => {
    expect(computeStreakDays(new Set(['2026-07-10']), '2026-07-14')).toBe(0);
    expect(computeStreakDays(new Set(), '2026-07-14')).toBe(0);
  });
});
