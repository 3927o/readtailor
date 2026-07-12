import React from 'react';

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Serif headline. @default '这里还空着' */
  title?: string;
  /** Muted serif explanation, ≤2 short lines. */
  children?: React.ReactNode;
  /** One action, usually a secondary/ghost Button. */
  action?: React.ReactNode;
}

/**
 * Quiet empty state — ⌜ ⌟ corners, serif line, optional single action.
 */
export function EmptyState(props: EmptyStateProps): JSX.Element;
