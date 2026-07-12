import React from 'react';

/**
 * Chip — a pill toggle. The product's controls (book picker, "卡在哪 /
 * 想拿到" questions) and the brief's profile tags are all chips. Selected
 * state is a soft-green wash + green border; the resting state is a quiet
 * hairline outline. Labelled in the UI sans by default.
 */
export function Chip({
  children,
  selected = false,
  as = 'button',
  serif = false,
  onClick,
  style,
  ...rest
}) {
  const Tag = as;
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    flex: 'none',
    whiteSpace: 'nowrap',
    fontFamily: serif ? 'var(--rt-serif)' : 'var(--rt-demo)',
    fontSize: 12.5,
    fontWeight: selected ? 600 : 400,
    padding: '7px 13px',
    borderRadius: 'var(--rt-radius-pill, 999px)',
    border: '1px solid',
    cursor: Tag === 'button' ? 'pointer' : 'default',
    transition: 'color 160ms, background 160ms, border-color 160ms',
    color: selected ? 'var(--rt-green-deep)' : 'var(--rt-ink-2)',
    background: selected ? 'var(--rt-green-soft)' : 'transparent',
    borderColor: selected ? 'var(--rt-green)' : 'var(--rt-rule)',
  };
  const enter = (e) => {
    if (selected || Tag !== 'button') return;
    e.currentTarget.style.color = 'var(--rt-ink)';
    e.currentTarget.style.borderColor = 'var(--rt-ink-3)';
  };
  const leave = (e) => {
    if (selected || Tag !== 'button') return;
    e.currentTarget.style.color = 'var(--rt-ink-2)';
    e.currentTarget.style.borderColor = 'var(--rt-rule)';
  };
  return (
    <Tag
      onClick={onClick}
      aria-selected={Tag === 'button' ? selected : undefined}
      onMouseEnter={enter}
      onMouseLeave={leave}
      style={{ ...base, ...style }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
