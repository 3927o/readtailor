import type { HTMLAttributes, ReactNode } from 'react';

export interface SegmentedOption<Value extends string = string> {
  value: Value;
  label: ReactNode;
}

export interface SegmentedProps<Value extends string = string> extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange'> {
  options: readonly (Value | SegmentedOption<Value>)[];
  value?: Value;
  onChange?: (value: Value) => void;
  label: string;
}

export function Segmented<Value extends string>({
  options,
  value,
  onChange,
  label,
  className,
  ...rest
}: SegmentedProps<Value>) {
  const normalizedOptions = options.map((option) => (
    typeof option === 'string' ? { value: option, label: option } : option
  ));

  return (
    <div
      className={['rt-segmented', className].filter(Boolean).join(' ')}
      role="radiogroup"
      aria-label={label}
      {...rest}
    >
      {normalizedOptions.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={selected}
            data-selected={selected}
            tabIndex={selected || (value === undefined && index === 0) ? 0 : -1}
            onClick={() => onChange?.(item.value)}
            onKeyDown={(event) => {
              let nextIndex: number | undefined;
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                nextIndex = (index + 1) % normalizedOptions.length;
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                nextIndex = (index - 1 + normalizedOptions.length) % normalizedOptions.length;
              } else if (event.key === 'Home') {
                nextIndex = 0;
              } else if (event.key === 'End') {
                nextIndex = normalizedOptions.length - 1;
              }
              if (nextIndex === undefined) return;
              event.preventDefault();
              const nextOption = normalizedOptions[nextIndex];
              if (!nextOption) return;
              onChange?.(nextOption.value);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[nextIndex]
                ?.focus();
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
