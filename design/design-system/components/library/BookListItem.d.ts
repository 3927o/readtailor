import React from 'react';

export interface BookListItemProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Book title (serif). */
  title?: string;
  /** Author, joined to meta with an interpunct. */
  author?: string;
  /** Extra meta — e.g. "读到 第三章" or "12 条批注". */
  meta?: string;
  /** Reading progress 0–100. Renders the 2px green sliver + mono %. */
  progress?: number;
  /** Real cover image URL (falls back to the typographic jacket). */
  src?: string;
  /** Row tap handler; presence makes the row hoverable + keyboard-operable. */
  onClick?: (e: React.SyntheticEvent) => void;
}

/**
 * Bookshelf list row: sm cover, serif title, muted meta, progress sliver.
 */
export function BookListItem(props: BookListItemProps): JSX.Element;
