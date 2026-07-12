import React from 'react';
import { BookCover } from './BookCover.jsx';

/**
 * BookListItem — one row of the bookshelf list: sm cover thumb, serif
 * title, muted meta line, and an optional reading-progress sliver (the
 * 2px green line, echoing the landing's progress bar). Quiet hairline
 * separator below; soft-green wash on hover.
 */
export function BookListItem({
  title,
  author,
  meta,
  progress,
  src,
  onClick,
  style,
  ...rest
}) {
  const clickable = typeof onClick === 'function';
  return (
    <div
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(e); } } : undefined}
      onMouseEnter={clickable ? (e) => { e.currentTarget.style.background = 'var(--rt-green-soft)'; } : undefined}
      onMouseLeave={clickable ? (e) => { e.currentTarget.style.background = 'transparent'; } : undefined}
      style={{
        display: 'flex',
        gap: 16,
        alignItems: 'center',
        padding: '14px 12px',
        borderBottom: '1px solid var(--rt-rule-2)',
        borderRadius: '0 4px 4px 0',
        cursor: clickable ? 'pointer' : 'default',
        transition: 'background 160ms',
        minHeight: 44,
        ...style,
      }}
      {...rest}
    >
      <BookCover size="sm" title={title} author={author} src={src} style={{ boxShadow: 'none' }} />
      <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{
          fontFamily: 'var(--rt-serif)',
          fontSize: 16,
          fontWeight: 600,
          letterSpacing: '0.02em',
          color: 'var(--rt-ink)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {title}
        </div>
        {(author || meta) ? (
          <div style={{ fontFamily: 'var(--rt-demo)', fontSize: 12.5, color: 'var(--rt-ink-3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {[author, meta].filter(Boolean).join(' · ')}
          </div>
        ) : null}
        {typeof progress === 'number' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
            <div style={{ flex: 1, maxWidth: 180, height: 2, background: 'var(--rt-rule-2)', borderRadius: 999, overflow: 'hidden' }}>
              <div style={{ width: `${Math.max(0, Math.min(100, progress))}%`, height: '100%', background: 'var(--rt-green)', transition: 'width 400ms cubic-bezier(.2,.7,.2,1)' }}></div>
            </div>
            <span style={{ fontFamily: 'var(--rt-mono)', fontSize: 9, letterSpacing: '0.14em', color: 'var(--rt-ink-3)' }}>
              {Math.round(progress)}%
            </span>
          </div>
        ) : null}
      </div>
      {clickable ? (
        <span aria-hidden="true" style={{ fontFamily: 'var(--rt-serif)', fontSize: 16, color: 'var(--rt-ink-3)', flex: 'none' }}>›</span>
      ) : null}
    </div>
  );
}
