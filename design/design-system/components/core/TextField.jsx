import React from 'react';

/**
 * TextField — a quiet boxed input for forms (昵称, 提问框之外的输入).
 * Hairline border, asymmetric 0 4px 4px 0 radius, green border on
 * focus; brick-red only for errors. Supports multiline.
 */
export function TextField({
  value,
  onChange,
  label,
  placeholder,
  error,
  multiline = false,
  rows = 3,
  style,
  inputStyle,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const id = React.useId();
  const borderColor = error ? 'var(--rt-error)' : focus ? 'var(--rt-green)' : 'var(--rt-rule)';
  const shared = {
    width: '100%',
    boxSizing: 'border-box',
    border: `1px solid ${borderColor}`,
    borderRadius: '0 4px 4px 0',
    background: 'var(--rt-bg-card)',
    fontFamily: 'var(--rt-demo)',
    fontSize: 14,
    lineHeight: 1.6,
    color: 'var(--rt-ink)',
    padding: '10px 12px',
    outline: 'none',
    transition: 'border-color 160ms',
    resize: multiline ? 'vertical' : undefined,
    ...inputStyle,
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, ...style }} {...rest}>
      {label ? (
        <label htmlFor={id} style={{
          fontFamily: 'var(--rt-mono)',
          fontSize: 9,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: error ? 'var(--rt-error)' : 'var(--rt-ink-3)',
        }}>
          {label}
        </label>
      ) : null}
      {multiline ? (
        <textarea id={id} rows={rows} value={value} onChange={onChange} placeholder={placeholder}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} style={shared} />
      ) : (
        <input id={id} type="text" value={value} onChange={onChange} placeholder={placeholder}
          onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} style={shared} />
      )}
      {error ? (
        <div style={{ fontFamily: 'var(--rt-demo)', fontSize: 12, color: 'var(--rt-error)' }}>{error}</div>
      ) : null}
    </div>
  );
}
