import React from 'react';

/**
 * Segmented — a 2–4 option segmented control (主题 纸白/纸黄/夜间, 视图
 * 网格/列表). A hairline pill track; the selected segment gets the
 * soft-green wash + green text. Sans voice, quiet.
 */
export function Segmented({
  options = [],
  value,
  onChange,
  label,
  style,
  ...rest
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 2,
        border: '1px solid var(--rt-rule)',
        borderRadius: 999,
        background: 'var(--rt-bg)',
        ...style,
      }}
      {...rest}
    >
      {options.map((opt) => {
        const o = typeof opt === 'string' ? { value: opt, label: opt } : opt;
        const sel = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={sel}
            onClick={() => onChange && onChange(o.value)}
            onMouseEnter={(e) => { if (!sel) e.currentTarget.style.color = 'var(--rt-ink)'; }}
            onMouseLeave={(e) => { if (!sel) e.currentTarget.style.color = 'var(--rt-ink-3)'; }}
            style={{
              fontFamily: 'var(--rt-demo)',
              fontSize: 12.5,
              fontWeight: sel ? 600 : 400,
              padding: '6px 14px',
              borderRadius: 999,
              border: 'none',
              cursor: 'pointer',
              background: sel ? 'var(--rt-green-soft)' : 'transparent',
              color: sel ? 'var(--rt-green-deep)' : 'var(--rt-ink-3)',
              transition: 'color 160ms, background 160ms',
              whiteSpace: 'nowrap',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
