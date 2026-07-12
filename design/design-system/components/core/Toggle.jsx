import React from 'react';

/**
 * Toggle — a quiet switch for settings rows (夜间模式, 自动批注…). Off is a
 * hairline pill; on fills sage green. No bounce; 160ms ease.
 */
export function Toggle({
  checked = false,
  onChange,
  disabled = false,
  label,
  style,
  ...rest
}) {
  const toggle = () => { if (!disabled && onChange) onChange(!checked); };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={toggle}
      style={{
        position: 'relative',
        width: 40,
        height: 24,
        flex: 'none',
        borderRadius: 999,
        border: `1px solid ${checked ? 'var(--rt-green)' : 'var(--rt-rule)'}`,
        background: checked ? 'var(--rt-green)' : 'var(--rt-bg-2)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        padding: 0,
        transition: 'background 160ms, border-color 160ms',
        ...style,
      }}
      {...rest}
    >
      <span style={{
        position: 'absolute',
        top: 2,
        left: checked ? 18 : 2,
        width: 18,
        height: 18,
        borderRadius: '50%',
        background: 'var(--rt-bg-card)',
        boxShadow: '0 1px 3px rgba(10,10,9,0.18)',
        transition: 'left 160ms cubic-bezier(.2,.7,.2,1)',
      }}></span>
    </button>
  );
}
