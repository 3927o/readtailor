import React from 'react';

export interface SliderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** @default 50 */
  value?: number;
  /** @default 0 */
  min?: number;
  /** @default 100 */
  max?: number;
  /** @default 1 */
  step?: number;
  /** Receives the numeric value. */
  onChange?: (value: number) => void;
  /** Accessible name, e.g. '字号'. */
  label?: string;
  /** Show a mono value readout on the right. @default false */
  showValue?: boolean;
  /** Format the readout, e.g. v => v + 'px'. */
  format?: (value: number) => string;
  /** @default false */
  disabled?: boolean;
}

/**
 * Hairline range slider for reader settings (字号 / 行距 / 批注密度).
 */
export function Slider(props: SliderProps): JSX.Element;
