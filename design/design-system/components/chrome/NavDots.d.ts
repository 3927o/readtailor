import React from 'react';

export interface NavDotsProps extends React.HTMLAttributes<HTMLElement> {
  /** Total pages. */
  count?: number;
  /** Active page index. @default 0 */
  current?: number;
  /** Index rendered as a 45° diamond (e.g. the closing page). @default -1 */
  specialIndex?: number;
  /** Jump handler. */
  onJump?: (index: number) => void;
}

/** Minimal bottom page-dot navigator; current dot stretches to a green pill. */
export function NavDots(props: NavDotsProps): JSX.Element;
