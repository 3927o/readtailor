import React from 'react';

export interface SegmentedOption {
  value: string;
  label: React.ReactNode;
}

export interface SegmentedProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** 2–4 options; strings or {value,label}. */
  options?: (string | SegmentedOption)[];
  /** Selected option value. */
  value?: string;
  /** Receives the picked value. */
  onChange?: (value: string) => void;
  /** Accessible group name, e.g. '阅读主题'. */
  label?: string;
}

/**
 * Segmented control — hairline pill track, soft-green selected segment.
 */
export function Segmented(props: SegmentedProps): JSX.Element;
