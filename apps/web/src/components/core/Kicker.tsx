import type { HTMLAttributes } from 'react';

export interface KickerProps extends HTMLAttributes<HTMLParagraphElement> {
  center?: boolean;
}

export function Kicker({ children, center = false, className, ...rest }: KickerProps) {
  return (
    <p
      className={['rt-kicker', center && 'rt-kicker--center', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <span aria-hidden="true" />
      {children}
    </p>
  );
}
