import React from 'react';

/**
 * BookCover — a typographic placeholder cover. ReadTailor ships no book
 * imagery; covers are set like quiet hardback jackets: warm card, hairline
 * frame, a 2px green spine on the left (the brand's signature edge),
 * vertical-ish serif title, mono author line. Pass `src` when a real
 * cover image exists.
 */
export function BookCover({
  title,
  author,
  src,
  size = 'md',
  style,
  ...rest
}) {
  const widths = { sm: 72, md: 108, lg: 148 };
  const w = widths[size] || widths.md;
  const h = Math.round(w * 4 / 3);

  const frame = {
    position: 'relative',
    width: w,
    height: h,
    flex: 'none',
    background: 'var(--rt-bg-card)',
    border: '1px solid var(--rt-rule)',
    borderLeft: '2px solid var(--rt-green)',
    borderRadius: '0 4px 4px 0',
    boxShadow: '0 6px 24px -16px rgba(20,40,30,0.25)',
    overflow: 'hidden',
    boxSizing: 'border-box',
  };

  if (src) {
    return (
      <div style={{ ...frame, ...style }} {...rest}>
        <img src={src} alt={title || ''} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      </div>
    );
  }

  const titleSizes = { sm: 12, md: 15, lg: 19 };
  const metaSizes = { sm: 7, md: 8, lg: 9 };

  return (
    <div style={{ ...frame, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: size === 'sm' ? '10px 8px' : '14px 12px', ...style }} {...rest}>
      <div style={{
        fontFamily: 'var(--rt-serif)',
        fontSize: titleSizes[size] || titleSizes.md,
        fontWeight: 600,
        lineHeight: 1.45,
        letterSpacing: '0.06em',
        color: 'var(--rt-ink)',
        display: '-webkit-box',
        WebkitLineClamp: 4,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>
        {title}
      </div>
      {author ? (
        <div style={{
          fontFamily: 'var(--rt-mono)',
          fontSize: metaSizes[size] || metaSizes.md,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--rt-ink-3)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {author}
        </div>
      ) : null}
    </div>
  );
}
