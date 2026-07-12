import React from 'react';

export interface PhoneFrameProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Bezel width in px. @default 280 */
  width?: number;
  /** Bezel height in px. @default 560 */
  height?: number;
  /** Extra styles for the inner screen surface. */
  screenStyle?: React.CSSProperties;
  children?: React.ReactNode;
}

/**
 * Dark device shell for product demos; interior speaks the UI-sans voice.
 *
 * @startingPoint section="Chrome" subtitle="Phone shell for app demos" viewport="360x620"
 */
export function PhoneFrame(props: PhoneFrameProps): JSX.Element;
