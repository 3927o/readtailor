import React from 'react';

/**
 * EmptyState — the quiet empty shelf. Letter voice: a short serif line,
 * a muted explanation, optionally one action. Marked by the ⌜ ⌟
 * quote-corners, not an illustration.
 */
export function EmptyState({
  title = '这里还空着',
  children,
  action,
  style,
  ...rest
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14,
        padding: '56px 24px',
        textAlign: 'center',
        ...style,
      }}
      {...rest}
    >
      <div aria-hidden="true" style={{ fontFamily: 'var(--rt-serif)', fontSize: 22, color: 'var(--rt-ink-3)', letterSpacing: '0.3em' }}>⌜ ⌟</div>
      <div style={{ fontFamily: 'var(--rt-serif)', fontSize: 17, fontWeight: 600, color: 'var(--rt-ink)', letterSpacing: '0.04em' }}>
        {title}
      </div>
      {children ? (
        <div style={{ fontFamily: 'var(--rt-serif)', fontSize: 13.5, lineHeight: 1.9, color: 'var(--rt-ink-3)', maxWidth: '30ch' }}>
          {children}
        </div>
      ) : null}
      {action ? <div style={{ marginTop: 6 }}>{action}</div> : null}
    </div>
  );
}
