import React from 'react';

export type MarkType = 'gloss' | 'fillin' | 'margin';

export interface MarkProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Note type → underline style. dotted/dashed/wavy. @default 'gloss' */
  type?: MarkType;
  /** Currently open (keeps the green wash). @default false */
  active?: boolean;
  /** Fired on click / Enter — open the gloss popover. */
  onActivate?: (e: React.SyntheticEvent) => void;
  children?: React.ReactNode;
}

/** Inline tappable annotation anchor inside running text. */
export function Mark(props: MarkProps): JSX.Element;
