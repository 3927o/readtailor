import React from 'react';

export interface ShelfGridProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Minimum column width in px (tracks the cover size used). @default 108 */
  min?: number;
  /** Grid gap in px. @default 24 */
  gap?: number;
  children?: React.ReactNode;
}

/**
 * Responsive bookshelf cover grid (auto-fill, generous gaps).
 */
export function ShelfGrid(props: ShelfGridProps): JSX.Element;
