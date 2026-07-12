import React from 'react';

/**
 * TOCList — the table-of-contents (目录) list for the reader drawer.
 * Serif chapter titles, mono numerals, hairline separators. The current
 * chapter carries the signature 2px green left edge + soft wash; read
 * chapters are muted.
 */
export function TOCList({
  chapters = [],
  current,
  onSelect,
  style,
  ...rest
}) {
  return (
    <div role="list" style={{ display: 'flex', flexDirection: 'column', ...style }} {...rest}>
      {chapters.map((ch, i) => {
        const isCurrent = (ch.id ?? i) === current;
        const done = !!ch.read && !isCurrent;
        return (
          <button
            key={ch.id ?? i}
            type="button"
            role="listitem"
            aria-current={isCurrent ? 'true' : undefined}
            onClick={() => onSelect && onSelect(ch.id ?? i)}
            onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = 'var(--rt-green-soft)'; }}
            onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = 'transparent'; }}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 14,
              textAlign: 'left',
              width: '100%',
              boxSizing: 'border-box',
              padding: '13px 14px',
              minHeight: 44,
              border: 'none',
              borderBottom: '1px solid var(--rt-rule-2)',
              borderLeft: isCurrent ? '2px solid var(--rt-green)' : '2px solid transparent',
              borderRadius: '0 4px 4px 0',
              background: isCurrent ? 'var(--rt-green-soft)' : 'transparent',
              cursor: 'pointer',
              transition: 'background 160ms',
            }}
          >
            <span style={{
              fontFamily: 'var(--rt-mono)',
              fontSize: 9,
              letterSpacing: '0.14em',
              color: isCurrent ? 'var(--rt-green)' : 'var(--rt-ink-3)',
              minWidth: 22,
              flex: 'none',
            }}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <span style={{
              flex: 1,
              minWidth: 0,
              fontFamily: 'var(--rt-serif)',
              fontSize: 14.5,
              fontWeight: isCurrent ? 600 : 400,
              lineHeight: 1.6,
              color: isCurrent ? 'var(--rt-ink)' : done ? 'var(--rt-ink-3)' : 'var(--rt-ink-2)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {ch.title}
            </span>
            {done ? (
              <span aria-label="已读" style={{ fontFamily: 'var(--rt-mono)', fontSize: 9, letterSpacing: '0.12em', color: 'var(--rt-ink-3)', flex: 'none' }}>READ</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
