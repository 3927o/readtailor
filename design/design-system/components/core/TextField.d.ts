import React from 'react';

export interface TextFieldProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Controlled value. */
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  /** Mono uppercase label above the field. */
  label?: string;
  placeholder?: string;
  /** Error message — brick-red border + message (the only red in the system). */
  error?: string;
  /** Render a <textarea>. @default false */
  multiline?: boolean;
  /** Textarea rows. @default 3 */
  rows?: number;
  /** Extra styles for the inner input/textarea. */
  inputStyle?: React.CSSProperties;
}

/**
 * Quiet boxed input — hairline border, asymmetric radius, green focus.
 */
export function TextField(props: TextFieldProps): JSX.Element;
