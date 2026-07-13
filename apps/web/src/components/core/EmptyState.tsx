import type { HTMLAttributes, ReactNode } from 'react';

export interface EmptyStateProps extends HTMLAttributes<HTMLElement> {
  title?: string;
  action?: ReactNode;
}

export function EmptyState({
  title = '这里还空着',
  children,
  action,
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <section className={['rt-empty-state', className].filter(Boolean).join(' ')} {...rest}>
      <div className="rt-empty-state__corners" aria-hidden="true">⌜ ⌟</div>
      <h2>{title}</h2>
      {children ? <div className="rt-empty-state__detail">{children}</div> : null}
      {action ? <div className="rt-empty-state__action">{action}</div> : null}
    </section>
  );
}
