import React from 'react';

export interface TOCChapter {
  /** Stable id; index is used when omitted. */
  id?: string | number;
  /** Chapter title (serif). */
  title: string;
  /** Marks the chapter as finished (muted + READ tag). */
  read?: boolean;
}

export interface TOCListProps extends React.HTMLAttributes<HTMLDivElement> {
  chapters?: TOCChapter[];
  /** id (or index) of the current chapter — gets the green left edge. */
  current?: string | number;
  onSelect?: (id: string | number) => void;
}

/**
 * 目录 list — mono numerals, serif titles, green left edge on the current chapter.
 */
export function TOCList(props: TOCListProps): JSX.Element;
