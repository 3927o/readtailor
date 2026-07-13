import type { HTMLAttributes } from 'react';

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  value?: number;
  height?: number;
}

export function ProgressBar({ value = 0, height = 2, className, style, ...rest }: ProgressBarProps) {
  const percentage = Math.max(0, Math.min(100, value));
  return (
    <div
      className={['rt-progress', className].filter(Boolean).join(' ')}
      style={{ height, ...style }}
      role="progressbar"
      aria-valuenow={Math.round(percentage)}
      aria-valuemin={0}
      aria-valuemax={100}
      {...rest}
    >
      <span style={{ width: `${percentage}%` }} />
    </div>
  );
}
