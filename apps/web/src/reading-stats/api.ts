import type { ReadingStatsGlobal, ReadingStatsPerBook } from '@readtailor/contracts';
import { apiBaseUrl } from '../library/api';

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('readtailor:unauthorized'));
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === 'string' ? body.error : `请求失败（${response.status}）`);
  }
  return response.json() as Promise<T>;
}

export async function getGlobalReadingStats(day: string, weekStart: string): Promise<ReadingStatsGlobal> {
  const params = new URLSearchParams({ day, weekStart });
  return readJson<ReadingStatsGlobal>(await fetch(
    `${apiBaseUrl}/v1/me/reading-stats?${params.toString()}`,
    { credentials: 'include' },
  ));
}

export async function getBookReadingStats(userBookId: string): Promise<ReadingStatsPerBook> {
  return readJson<ReadingStatsPerBook>(await fetch(
    `${apiBaseUrl}/v1/user-books/${encodeURIComponent(userBookId)}/reading-stats`,
    { credentials: 'include' },
  ));
}

