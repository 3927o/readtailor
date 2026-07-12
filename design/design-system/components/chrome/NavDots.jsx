import React from 'react';

/**
 * NavDots — the minimal page-dot navigator that floats at the bottom of
 * the landing. The current dot stretches into a green pill with a soft
 * halo; passed dots are faded green; a `special` dot rotates 45° into a
 * diamond (used for the closing vision page).
 */
export function NavDots({ count = 0, current = 0, specialIndex = -1, onJump, style, ...rest }) {
  return (
    <nav
      aria-label="page navigation"
      style={{
        display: 'inline-flex', gap: 7, alignItems: 'center',
        padding: '6px 11px', borderRadius: 999,
        background: 'rgba(250,250,246,0.72)', backdropFilter: 'blur(6px)',
        ...style,
      }}
      {...rest}
    >
      {Array.from({ length: count }).map((_, i) => {
        const isCurrent = i === current;
        const isPast = i < current;
        const special = i === specialIndex;
        const base = {
          width: 6, height: 6, borderRadius: '50%', padding: 0, border: 'none',
          cursor: 'pointer', transition: 'all 220ms var(--rt-ease)',
          background: isCurrent ? 'var(--rt-green)' : isPast ? 'rgba(47,106,82,0.4)' : 'rgba(10,10,9,0.18)',
        };
        const currentExtra = isCurrent && !special
          ? { width: 16, borderRadius: 4, boxShadow: '0 0 0 3px rgba(47,106,82,0.12)' }
          : {};
        const specialExtra = special
          ? { transform: 'rotate(45deg)', borderRadius: 1, ...(isCurrent ? { width: 8, height: 8 } : {}) }
          : {};
        return (
          <button
            key={i}
            type="button"
            aria-label={`page ${i + 1}`}
            aria-current={isCurrent ? 'true' : undefined}
            onClick={() => onJump && onJump(i)}
            style={{ ...base, ...currentExtra, ...specialExtra }}
          />
        );
      })}
    </nav>
  );
}
