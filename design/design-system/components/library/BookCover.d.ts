import React from 'react';

export interface BookCoverProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Book title, set in the serif voice on the placeholder jacket. */
  title?: string;
  /** Author / edition line — mono, uppercase, tracked. */
  author?: string;
  /** Real cover image URL. When present the typographic jacket is replaced. */
  src?: string;
  /** Cover width: sm 72px · md 108px · lg 148px (3:4 ratio). @default 'md' */
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Typographic placeholder book cover with the signature green spine edge.
 */
export function BookCover(props: BookCoverProps): JSX.Element;
