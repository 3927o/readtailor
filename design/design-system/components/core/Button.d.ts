import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight. `primary` is the green pill — use it once per view. */
  variant?: ButtonVariant;
  /** Control height / padding. @default 'md' */
  size?: ButtonSize;
  children?: React.ReactNode;
}

/**
 * ReadTailor's primary action — a serif-labelled green pill.
 *
 * @startingPoint section="Core" subtitle="Green pill action button" viewport="700x150"
 */
export function Button(props: ButtonProps): JSX.Element;
