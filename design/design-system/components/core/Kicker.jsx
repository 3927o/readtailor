import React from 'react';

/**
 * Kicker — the magazine column-head. Mono, uppercase, wide-tracked, with
 * a leading 28px green rule. Sits above headings to label a section
 * ("问题 · The Problem"). The bilingual CN · EN pattern is idiomatic.
 */
export function Kicker({ children, as = 'span', center = false, style, ...rest }) {
  const Tag = as;
  return (
    <Tag
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: center ? 'center' : 'flex-start',
        gap: 12,
        fontFamily: 'var(--rt-mono)',
        fontSize: 10,
        letterSpacing: '0.2em',
        textTransform: 'uppercase',
        color: 'var(--rt-green)',
        ...style,
      }}
      {...rest}
    >
      <span aria-hidden="true" style={{ width: 28, height: 1, background: 'var(--rt-green)', flex: 'none' }} />
      {children}
    </Tag>
  );
}
