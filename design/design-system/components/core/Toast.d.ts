import React from 'react';

export interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Controls fade/rise in-out; keep mounted and flip this. @default true */
  visible?: boolean;
  /** Use the ✦ AI sparkle instead of the green dot (AI-related notes only). @default false */
  accent?: boolean;
  children?: React.ReactNode;
}

/**
 * Quiet frosted toast pill, bottom-centre. Serif voice.
 */
export function Toast(props: ToastProps): JSX.Element;
