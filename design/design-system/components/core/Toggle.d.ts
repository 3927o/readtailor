import React from 'react';

export interface ToggleProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> {
  /** @default false */
  checked?: boolean;
  /** Receives the next boolean value. */
  onChange?: (next: boolean) => void;
  /** @default false */
  disabled?: boolean;
  /** Accessible name (the visible label usually lives in the settings row). */
  label?: string;
}

/**
 * Quiet settings switch — hairline off, sage-green on, no bounce.
 */
export function Toggle(props: ToggleProps): JSX.Element;
