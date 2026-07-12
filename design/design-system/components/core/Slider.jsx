import React from 'react';

/**
 * Slider — a hairline range control for reader settings (字号 / 行距 /
 * 批注密度). A 2px track (echoing the progress sliver) with a small
 * round thumb; the filled side is green. Optional mono value readout.
 */
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
  style,
  ...rest
}) {
  const pct = ((value - min) / (max - min || 1)) * 100;
  const id = React.useId();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: disabled ? 0.45 : 1, ...style }} {...rest}>
      <div style={{ position: 'relative', flex: 1, height: 24, display: 'flex', alignItems: 'center' }}>
        <div aria-hidden="true" style={{ position: 'absolute', left: 0, right: 0, height: 2, borderRadius: 999, background: 'var(--rt-rule-2)' }}></div>
        <div aria-hidden="true" style={{ position: 'absolute', left: 0, width: `${pct}%`, height: 2, borderRadius: 999, background: 'var(--rt-green)' }}></div>
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => onChange && onChange(Number(e.target.value))}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            margin: 0,
            opacity: 0,
            cursor: disabled ? 'default' : 'pointer',
          }}
        />
        <div aria-hidden="true" style={{
          position: 'absolute',
          left: `calc(${pct}% - 8px)`,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: 'var(--rt-bg-card)',
          border: '1px solid var(--rt-green)',
          boxShadow: '0 1px 3px rgba(10,10,9,0.15)',
          pointerEvents: 'none',
          transition: 'left 60ms linear',
        }}></div>
      </div>
      {showValue ? (
        <span style={{ fontFamily: 'var(--rt-mono)', fontSize: 10, letterSpacing: '0.1em', color: 'var(--rt-ink-3)', minWidth: 34, textAlign: 'right', flex: 'none' }}>
          {format ? format(value) : value}
        </span>
      ) : null}
    </div>
  );
}
