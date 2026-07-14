import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { ReadingStatsPerBook } from '@readtailor/contracts';
import { Link } from 'react-router';
import { EmptyState } from '../components/core/EmptyState';
import { Kicker } from '../components/core/Kicker';
import { LibraryChrome } from '../library/LibraryChrome';
import { getUserBooks } from '../user-books/api';
import type { UserBookSummary } from '../user-books/api';
import { localDay, localWeekStart } from '../reader/session';
import { getBookReadingStats, getGlobalReadingStats } from './api';
import { formatLastRead, formatReadingDuration, formatRemaining } from './format';

interface RecentDay {
  day: string;
  label: string;
  seconds: number;
  isToday: boolean;
}

export function StatsPage() {
  const now = useMemo(() => Date.now(), []);
  const today = localDay(now);
  const weekStart = localWeekStart(now);
  const recentDays = useMemo(() => buildRecentDays(now), [now]);

  const global = useQuery({
    queryKey: ['reading-stats-global', today, weekStart],
    queryFn: () => getGlobalReadingStats(today, weekStart),
  });
  const daily = useQuery({
    queryKey: ['reading-stats-recent-days', recentDays.map((day) => day.day).join(',')],
    queryFn: async () => Promise.all(recentDays.map(async (day) => ({
      ...day,
      seconds: (await getGlobalReadingStats(day.day, localWeekStart(localDateMidday(day.day)))).todaySeconds,
    }))),
  });
  const books = useQuery({ queryKey: ['user-books'], queryFn: getUserBooks });
  const activeBooks = useMemo(
    () => books.data?.userBooks.filter((book) => book.workflowStatus === 'active_reading') ?? [],
    [books.data?.userBooks],
  );
  const bookStats = useQueries({
    queries: activeBooks.map((book) => ({
      queryKey: ['reading-stats-book', book.id],
      queryFn: () => getBookReadingStats(book.id),
      staleTime: 30_000,
    })),
  });

  const loading = global.isPending || daily.isPending || books.isPending || bookStats.some((query) => query.isPending);
  const error = global.error ?? daily.error ?? books.error ?? bookStats.find((query) => query.error)?.error;

  return (
    <LibraryChrome showBack={false}>
      <main className="stats-page">
        <Link className="text-button stats-back" to="/">‹ 书架</Link>
        <Kicker>阅读统计 · READING STATS</Kicker>
        <div className="stats-heading">
          <div>
            <h1>你走过的路</h1>
            <p>不比昨天多读了多少，只想让你看见：你一直在往前走。</p>
          </div>
        </div>

        {error ? (
          <EmptyState
            title="统计暂时没有打开"
            action={<button className="button button-ghost" type="button" onClick={() => {
              void global.refetch();
              void daily.refetch();
              void books.refetch();
            }}>重新连接</button>}
          >{error.message}</EmptyState>
        ) : (
          <>
            <section className="stats-card-grid" aria-label="阅读概览">
              <StatsCard value={global.data ? String(global.data.streakDays) : '—'} label="连续天数" />
              <StatsCard value={global.data ? String(Math.round(global.data.todaySeconds / 60)) : '—'} label="今日 · 分钟" />
              <StatsCard value={global.data ? (global.data.weekSeconds / 3600).toFixed(1) : '—'} label="本周 · 小时" />
            </section>

            <section className="stats-section" aria-label="近七天每天分钟数">
              <div className="stats-section-title">近七天 · 每天分钟数</div>
              <WeekBars days={daily.data ?? recentDays} loading={loading} />
            </section>

            <section className="stats-section" aria-label="在读书目进度">
              <div className="stats-section-title">在读 · 进度</div>
              {books.isPending ? (
                <div className="stats-list-loading">正在读取书架…</div>
              ) : activeBooks.length === 0 ? (
                <EmptyState
                  title="还没有在读书目"
                  action={<Link className="button button-secondary" to="/">去书架开始一本</Link>}
                >开始正式阅读后，这里会汇总每本书的进度和预计剩余时间。</EmptyState>
              ) : (
                <div className="stats-book-list">
                  {activeBooks.map((book, index) => (
                    <StatsBookRow
                      key={book.id}
                      book={book}
                      stats={bookStats[index]?.data}
                      loading={bookStats[index]?.isPending ?? false}
                    />
                  ))}
                </div>
              )}
            </section>

            <p className="stats-note">阅读速度按你实际停留的时长估算，越读越准。</p>
          </>
        )}
      </main>
    </LibraryChrome>
  );
}

function StatsCard({ value, label }: { value: string; label: string }) {
  return (
    <div className="stats-card">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function WeekBars({ days, loading }: { days: RecentDay[]; loading: boolean }) {
  const maxMinutes = Math.max(1, ...days.map((day) => Math.round(day.seconds / 60)));
  return (
    <div className="stats-week-bars" data-loading={loading}>
      {days.map((day) => {
        const minutes = Math.round(day.seconds / 60);
        const height = 6 + (minutes / maxMinutes) * 94;
        return (
          <div className="stats-week-bar" key={day.day} data-today={day.isToday} data-empty={minutes === 0}>
            <span>{minutes}</span>
            <i style={{ height: `${height}px` }} />
            <em>{day.label}</em>
          </div>
        );
      })}
    </div>
  );
}

function StatsBookRow({ book, stats, loading }: {
  book: UserBookSummary;
  stats: ReadingStatsPerBook | undefined;
  loading: boolean;
}) {
  const progress = stats?.progressPercent ?? book.readingProgress?.percent ?? 0;
  return (
    <Link className="stats-book-row" to={`/user-books/${book.id}/read`}>
      <div className="stats-book-row-copy">
        <div>
          <span>{book.sharedBook.title}</span>
          <strong>{loading ? '更新中…' : `${Math.round(progress)}% · ${formatRemaining(stats?.remaining)}`}</strong>
        </div>
        <p>{formatLastRead(stats?.lastReadAt ?? null)} · 累计 {stats ? formatReadingDuration(stats.totalEffectiveSeconds) : '—'}</p>
      </div>
      <div className="stats-book-progress" aria-label={`阅读进度 ${Math.round(progress)}%`}>
        <span style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
      </div>
    </Link>
  );
}

function buildRecentDays(nowMs: number): RecentDay[] {
  const today = localDay(nowMs);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(nowMs);
    date.setDate(date.getDate() - (6 - index));
    const day = localDay(date.getTime());
    return {
      day,
      label: ['日', '一', '二', '三', '四', '五', '六'][date.getDay()]!,
      seconds: 0,
      isToday: day === today,
    };
  });
}

function localDateMidday(day: string): number {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year!, month! - 1, date!, 12).getTime();
}
