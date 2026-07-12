import React from 'react';

export interface ReaderToolbarAction {
  /** Unicode glyph: '≡' 目录 · 'Aa' 设置 · '✦' AI (renders green). */
  glyph: React.ReactNode;
  /** Accessible name. */
  label: string;
  onClick?: () => void;
}

export interface ReaderToolbarProps extends React.HTMLAttributes<HTMLElement> {
  /** Book / chapter title (serif, centre-truncated). */
  title?: React.ReactNode;
  /** Shows the ‹ back glyph when provided. */
  onBack?: () => void;
  /** Right-side glyph actions, in order. */
  actions?: ReaderToolbarAction[];
  /** position:fixed at the viewport top. @default true */
  fixed?: boolean;
}

/**
 * Frosted reader top bar — ‹ back, serif title, unicode glyph actions.
 */
export function ReaderToolbar(props: ReaderToolbarProps): JSX.Element;
