import React from 'react';

export interface ProgressBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Progress 0–100. @default 0 */
  value?: number;
  /** Green→deep-green gradient fill instead of flat green. @default false */
  gradient?: boolean;
  /** Bar height in px. @default 3 */
  height?: number;
}

/** Thin top-pinned reading-progress sliver. */
export function ProgressBar(props: ProgressBarProps): JSX.Element;
