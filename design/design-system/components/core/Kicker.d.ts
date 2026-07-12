import React from 'react';

export interface KickerProps extends React.HTMLAttributes<HTMLElement> {
  /** Render element. @default 'span' */
  as?: keyof JSX.IntrinsicElements;
  /** Center the rule + label (for centered layouts). @default false */
  center?: boolean;
  children?: React.ReactNode;
}

/**
 * Magazine-style section label: mono, uppercase, leading green rule.
 *
 * @startingPoint section="Core" subtitle="Mono section kicker w/ green rule" viewport="700x120"
 */
export function Kicker(props: KickerProps): JSX.Element;
