import { useId } from 'react';
import type { HTMLAttributes } from 'react';

export interface SliderProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  onChange?: (value: number) => void;
  label: string;
  showValue?: boolean;
  format?: (value: number) => string;
  disabled?: boolean;
}

export function Slider({
  value = 50,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  label,
  showValue = false,
  format,
  disabled = false,
  className,
  ...rest
}: SliderProps) {
  const id = useId();
  const percentage = Math.max(0, Math.min(100, ((value - min) / (max - min || 1)) * 100));

  return (
    <div
      className={['rt-slider', className].filter(Boolean).join(' ')}
      data-disabled={disabled}
      {...rest}
    >
      <label className="rt-slider__label" htmlFor={id}>{label}</label>
      <div className="rt-slider__body">
        <div className="rt-slider__control">
          <span className="rt-slider__track" aria-hidden="true" />
          <span className="rt-slider__fill" style={{ width: `${percentage}%` }} aria-hidden="true" />
          <input
            id={id}
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange?.(Number(event.target.value))}
          />
          <span
            className="rt-slider__thumb"
            style={{ left: `calc(${percentage}% - 8px)` }}
            aria-hidden="true"
          />
        </div>
        {showValue ? <output htmlFor={id}>{format ? format(value) : value}</output> : null}
      </div>
    </div>
  );
}
