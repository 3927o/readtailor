import React from 'react';

/**
 * BottomNav — the app's三格底部导航 (书架 / 发现 / 我的). A frosted bar
 * (the dot-nav's "frosted cover" language) with word labels — no icons.
 * Selected tab: ink text + a small green dot above; others muted.
 */
export function BottomNav({
  items = [
    { value: 'shelf', label: '书架' },
    { value: 'discover', label: '发现' },
    { value: 'me', label: '我的' },
  ],
  value,
  onChange,
  fixed = true,
  style,
  ...rest
}) {
  return (
    <nav
      style={{
        position: fixed ? 'fixed' : 'relative',
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        justifyContent: 'space-around',
        alignItems: 'stretch',
        borderTop: '1px solid var(--rt-rule-2)',
        background: 'color-mix(in srgb, var(--rt-bg) 86%, transparent)',
        backdropFilter: 'saturate(150%) blur(10px)',
        WebkitBackdropFilter: 'saturate(150%) blur(10px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        zIndex: 40,
        ...style,
      }}
      {...rest}
    >
      {items.map((it) => {
        const sel = it.value === value;
        return (
          <button
            key={it.value}
            type="button"
            aria-current={sel ? 'page' : undefined}
            onClick={() => onChange && onChange(it.value)}
            onMouseEnter={(e) => { if (!sel) e.currentTarget.style.color = 'var(--rt-ink)'; }}
            onMouseLeave={(e) => { if (!sel) e.currentTarget.style.color = 'var(--rt-ink-3)'; }}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 4,
              padding: '10px 0 12px',
              minHeight: 52,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontFamily: 'var(--rt-serif)',
              fontSize: 13,
              fontWeight: sel ? 600 : 400,
              letterSpacing: '0.12em',
              color: sel ? 'var(--rt-ink)' : 'var(--rt-ink-3)',
              transition: 'color 160ms',
            }}
          >
            <span aria-hidden="true" style={{
              width: 4,
              height: 4,
              borderRadius: '50%',
              background: sel ? 'var(--rt-green)' : 'transparent',
              transition: 'background 160ms',
            }}></span>
            {it.label}
          </button>
        );
      })}
    </nav>
  );
}
