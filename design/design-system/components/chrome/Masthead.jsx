import React from 'react';

/**
 * Masthead — the editorial top bar. A serif wordmark on the left, a mono
 * issue line on the right, a hairline rule below, and a frosted-glass
 * backdrop. The fixed "this is a letter, with a cover" frame.
 */
export function Masthead({
  brand = '裁读',
  brandEn = 'ReadTailor',
  issue,
  fixed = true,
  style,
  ...rest
}) {
  return (
    <nav
      style={{
        ...(fixed ? { position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100 } : {}),
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        padding: '18px clamp(22px,5vw,48px) 14px',
        background: 'color-mix(in srgb, var(--rt-bg) 86%, transparent)',
        backdropFilter: 'var(--rt-glass, saturate(150%) blur(10px))',
        WebkitBackdropFilter: 'var(--rt-glass, saturate(150%) blur(10px))',
        borderBottom: '1px solid var(--rt-rule)',
        ...style,
      }}
      {...rest}
    >
      <span style={{ fontFamily: 'var(--rt-serif)', fontSize: 19, fontWeight: 700, letterSpacing: '-0.01em', color: 'var(--rt-ink)' }}>
        {brand}
        {brandEn && (
          <em style={{ fontStyle: 'italic', fontWeight: 400, color: 'var(--rt-ink-2)', marginLeft: 8, fontSize: 12, letterSpacing: '0.14em' }}>
            {brandEn}
          </em>
        )}
      </span>
      {issue && (
        <span style={{ fontFamily: 'var(--rt-mono)', fontSize: 10, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--rt-ink-3)' }}>
          {issue}
        </span>
      )}
    </nav>
  );
}
