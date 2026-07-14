import type { RemainingReadingTime } from '@readtailor/contracts';

export function formatReadingDuration(totalSeconds: number): string {
  const minutes = Math.max(0, Math.round(totalSeconds / 60));
  if (minutes < 1) return totalSeconds > 0 ? '1 分钟' : '0 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`;
}

export function formatRemaining(remaining: RemainingReadingTime | undefined): string {
  if (!remaining || remaining.seconds === null) return '—';
  const body = formatReadingDuration(remaining.seconds);
  return remaining.approximate ? `约 ${body}` : body;
}
