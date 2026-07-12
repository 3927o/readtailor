import React from 'react';

export interface MastheadProps extends React.HTMLAttributes<HTMLElement> {
  /** Chinese wordmark. @default '裁读' */
  brand?: string;
  /** Latin sub-mark, set in tracked italic. @default 'ReadTailor' */
  brandEn?: string;
  /** Right-side mono issue line, e.g. <span>BP · 2026</span>. */
  issue?: React.ReactNode;
  /** Pin to viewport top. @default true */
  fixed?: boolean;
}

/**
 * Editorial masthead — wordmark + issue line over a frosted hairline bar.
 *
 * @startingPoint section="Chrome" subtitle="Editorial top masthead" viewport="900x80"
 */
export function Masthead(props: MastheadProps): JSX.Element;
