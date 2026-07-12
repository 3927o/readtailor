import React from 'react';

/**
 * ShelfGrid — the bookshelf's cover grid. A plain responsive grid with
 * generous gaps; children are usually BookCover (optionally wrapped with
 * a caption). Column width tracks the md cover by default.
 */
export function ShelfGrid({
  min = 108,
  gap = 24,
  children,
  style,
  ...rest
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`,
        gap,
        justifyItems: 'start',
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
