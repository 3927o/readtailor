import React from 'react';

/**
 * ReaderToolbar — the reader's frosted top bar. Left: back ‹ + serif
 * book title; right: unicode-glyph actions (≡ 目录, Aa 设置, ✦ AI).
 * Meant to auto-hide while reading; show on tap. The 2px green
 * ProgressBar sits above it (compose separately).
 */
export function ReaderToolbar({
  title,
  onBack,
  actions = [],
  fixed = true,
  style,
  ...rest
}) {
  const glyphBtn = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 44,
    minHeight: 44,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: 'var(--rt-demo)',
    fontSize: 15,
    color: 'var(--rt-ink-2)',
    transition: 'color 160ms',
    padding: 0,
  };
  const hover = (e) => { e.currentTarget.style.color = 'var(--rt-ink)'; };
  const leave = (e) => { e.currentTarget.style.color = 'var(--rt-ink-2)'; };
  return (
    <header
      style={{
        position: fixed ? 'fixed' : 'relative',
        top: 0,
        left: 0,
        right: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 8px',
        paddingTop: 'env(safe-area-inset-top, 0px)',
        minHeight: 52,
        borderBottom: '1px solid var(--rt-rule-2)',
        background: 'color-mix(in srgb, var(--rt-bg) 86%, transparent)',
        backdropFilter: 'saturate(150%) blur(10px)',
        WebkitBackdropFilter: 'saturate(150%) blur(10px)',
        zIndex: 40,
        boxSizing: 'border-box',
        ...style,
      }}
      {...rest}
    >
      {onBack ? (
        <button type="button" aria-label="返回" onClick={onBack}
          onMouseEnter={hover} onMouseLeave={leave}
          style={{ ...glyphBtn, fontFamily: 'var(--rt-serif)', fontSize: 18 }}>
          ‹
        </button>
      ) : null}
      <div style={{
        flex: 1,
        minWidth: 0,
        fontFamily: 'var(--rt-serif)',
        fontSize: 14,
        fontWeight: 500,
        letterSpacing: '0.06em',
        color: 'var(--rt-ink)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}>
        {title}
      </div>
      {actions.map((a, i) => (
        <button key={i} type="button" aria-label={a.label} onClick={a.onClick}
          onMouseEnter={hover} onMouseLeave={leave}
          style={{ ...glyphBtn, color: a.glyph === '✦' ? 'var(--rt-green)' : glyphBtn.color }}>
          {a.glyph}
        </button>
      ))}
    </header>
  );
}
