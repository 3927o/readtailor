import React from 'react';

export interface ChipProps extends React.HTMLAttributes<HTMLElement> {
  /** Selected (soft-green wash + green border). @default false */
  selected?: boolean;
  /** Render element — 'button' for togglable, 'span' for a static tag. @default 'button' */
  as?: 'button' | 'span';
  /** Label in the serif voice instead of the UI sans (book titles). @default false */
  serif?: boolean;
  children?: React.ReactNode;
}

/**
 * Pill toggle / tag — product controls and profile chips.
 *
 * @startingPoint section="Core" subtitle="Selectable pill chip / tag" viewport="700x130"
 */
export function Chip(props: ChipProps): JSX.Element;
