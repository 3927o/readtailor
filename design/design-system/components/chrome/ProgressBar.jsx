import React from 'react';

/**
 * ProgressBar — the thin reading-progress sliver pinned to the top of the
 * viewport. A green fill on a transparent track, optional gradient.
 */
export function ProgressBar({ value = 0, gradient = false, height = 3, style, ...rest }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        position: 'fixed', top: 0, left: 0, zIndex: 120,
        height, width: `${pct}%`,
        background: gradient
          ? 'linear-gradient(90deg, var(--rt-green), var(--rt-green-deep))'
          : 'var(--rt-green)',
        transition: 'width 100ms linear',
        ...style,
      }}
      {...rest}
    />
  );
}
