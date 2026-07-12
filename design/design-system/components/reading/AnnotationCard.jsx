import React from 'react';

/**
 * AnnotationCard — ReadTailor's core container: the AI's notes laid
 * alongside the text. Three kinds, each a distinct print-like voice:
 *   · lead   章节导读  — green wash + solid green left edge; a kicker,
 *                        a title, and bullet points. The always-open
 *                        chapter lead-in.
 *   · margin 脉络      — a quiet hairline left rule; an anchor + a note.
 *   · fillin 推理补全  — sunken grey card, dotted left edge; the spelled-
 *                        out reasoning a sentence skipped over.
 */
export function AnnotationCard({
  kind = 'lead',
  kicker,
  title,
  anchor,
  trigger,
  bullets,
  children,
  style,
  ...rest
}) {
  const defaultKicker = { lead: '章节导读', margin: '脉络', fillin: '推理补全 ↳' }[kind];
  const head = kicker ?? defaultKicker;

  const shells = {
    lead: {
      background: 'var(--rt-green-soft)',
      borderLeft: '2px solid var(--rt-green)',
      borderRadius: '0 8px 8px 0',
      padding: '15px 18px',
    },
    margin: {
      borderLeft: '1.5px solid var(--rt-rule)',
      padding: '6px 0 4px 12px',
    },
    fillin: {
      background: 'var(--rt-bg-2)',
      borderLeft: '2px dotted var(--rt-ink-3)',
      borderRadius: '0 6px 6px 0',
      padding: '11px 14px',
    },
  };

  const headColor = kind === 'lead' ? 'var(--rt-green)' : kind === 'margin' ? 'var(--rt-ink-3)' : 'var(--rt-ink-3)';
  const bodyColor = kind === 'lead' ? 'var(--rt-green-deep)' : 'var(--rt-ink-2)';

  return (
    <aside style={{ margin: '0 0 16px', ...shells[kind], ...style }} {...rest}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: title || bullets || children ? 8 : 0 }}>
        <span style={{
          fontFamily: 'var(--rt-mono)', fontSize: 9, letterSpacing: '0.18em',
          textTransform: 'uppercase', fontWeight: 700, color: kind === 'lead' ? 'var(--rt-green)' : headColor,
        }}>{head}</span>
        {trigger && (
          <span style={{
            fontFamily: 'var(--rt-serif)', fontStyle: 'italic', fontSize: 10,
            letterSpacing: '0.04em', color: 'var(--rt-ink-3)',
          }}>触发 · {trigger}</span>
        )}
      </div>

      {title && (
        <h4 style={{
          margin: '0 0 9px', fontFamily: 'var(--rt-serif)', fontSize: 16.5,
          fontWeight: 700, color: 'var(--rt-green-deep)', lineHeight: 1.5,
        }}>{title}</h4>
      )}

      {kind === 'margin' && anchor && (
        <span style={{ fontWeight: 600, color: 'var(--rt-green-deep)', marginRight: 6, fontFamily: 'var(--rt-serif)' }}>
          {anchor} ·{' '}
        </span>
      )}

      {bullets && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {bullets.map((b, i) => (
            <li key={i} style={{
              position: 'relative', paddingLeft: 15, marginBottom: 6,
              fontFamily: 'var(--rt-serif)', fontSize: 14.5, lineHeight: 1.7, color: 'var(--rt-green-deep)',
            }}>
              <span aria-hidden="true" style={{ position: 'absolute', left: 3, fontWeight: 700, color: 'var(--rt-green)' }}>·</span>
              {b}
            </li>
          ))}
        </ul>
      )}

      {children && (
        <div style={{
          fontFamily: 'var(--rt-serif)', fontSize: 14, lineHeight: 1.7,
          color: bodyColor, display: 'inline',
        }}>{children}</div>
      )}
    </aside>
  );
}
