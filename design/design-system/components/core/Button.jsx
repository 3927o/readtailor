import React from 'react';

/**
 * Button — ReadTailor's primary action. A serif-labelled green pill by
 * default; quieter outline and ghost variants for secondary actions.
 * Green is the brand's only fill, so reserve `primary` for the one real
 * call-to-action on a view.
 */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  disabled = false,
  onClick,
  style,
  ...rest
}) {
  const pads = {
    sm: '8px 16px',
    md: '11px 22px',
    lg: '14px 28px',
  };
  const fontSizes = { sm: 13, md: 14, lg: 16 };

  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    fontFamily: "var(--rt-serif)",
    fontSize: fontSizes[size],
    fontWeight: 500,
    lineHeight: 1,
    padding: pads[size],
    borderRadius: 'var(--rt-radius-pill, 999px)',
    border: '1px solid transparent',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    transition: 'background 160ms, color 160ms, border-color 160ms',
    whiteSpace: 'nowrap',
    WebkitFontSmoothing: 'antialiased',
  };

  const variants = {
    primary: {
      background: 'var(--rt-green)',
      color: 'var(--rt-bg)',
    },
    secondary: {
      background: 'transparent',
      color: 'var(--rt-green-deep)',
      borderColor: 'var(--rt-green)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--rt-ink-2)',
      borderColor: 'var(--rt-rule)',
    },
  };

  const hoverEnter = (e) => {
    if (disabled) return;
    if (variant === 'primary') e.currentTarget.style.background = 'var(--rt-green-deep)';
    else if (variant === 'secondary') e.currentTarget.style.background = 'var(--rt-green-soft)';
    else { e.currentTarget.style.color = 'var(--rt-ink)'; e.currentTarget.style.borderColor = 'var(--rt-ink-3)'; }
  };
  const hoverLeave = (e) => {
    if (disabled) return;
    Object.assign(e.currentTarget.style, variants[variant]);
  };

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={hoverEnter}
      onMouseLeave={hoverLeave}
      style={{ ...base, ...variants[variant], ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}
