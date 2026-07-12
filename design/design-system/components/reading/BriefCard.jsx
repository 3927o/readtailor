import React from 'react';

/**
 * BriefCard — the "读前简报 / read-before-you-start" briefing. A white
 * card that frames a book before the reader opens it: what it is, where
 * it came from, the core terms, and a personalised "how to read it" prep
 * note. The last section can be flagged `prep` to get the green wash.
 */
export function BriefCard({ kicker = '读之前的简报', title, sections = [], terms, style, ...rest }) {
  return (
    <section
      style={{
        background: 'var(--rt-bg-card)',
        border: '1px solid var(--rt-rule)',
        borderRadius: 14,
        padding: '28px 28px 22px',
        boxShadow: 'var(--rt-shadow-card, 0 6px 24px -16px rgba(20,40,30,0.25))',
        ...style,
      }}
      {...rest}
    >
      <div style={{
        display: 'inline-flex', alignItems: 'center', gap: 12, marginBottom: 12,
        fontFamily: 'var(--rt-mono)', fontSize: 10, letterSpacing: '0.2em',
        textTransform: 'uppercase', color: 'var(--rt-green)',
      }}>
        <span aria-hidden="true" style={{ width: 28, height: 1, background: 'var(--rt-green)' }} />
        {kicker}
      </div>

      {title && (
        <h2 style={{
          margin: '0 0 18px', paddingBottom: 14, borderBottom: '1px solid var(--rt-rule-2)',
          fontFamily: 'var(--rt-serif)', fontSize: 23, fontWeight: 700, color: 'var(--rt-ink)',
        }}>{title}</h2>
      )}

      {sections.map((s, i) => {
        const prep = !!s.prep;
        return (
          <div key={i} style={{
            marginBottom: 18,
            ...(prep ? {
              background: 'var(--rt-green-soft)', borderLeft: '3px solid var(--rt-green)',
              borderRadius: '0 6px 6px 0', padding: '14px 16px',
            } : {}),
          }}>
            <div style={{
              fontSize: 14, fontWeight: 700, marginBottom: 5,
              color: prep ? 'var(--rt-green-deep)' : 'var(--rt-ink)',
            }}>{s.label}</div>
            <div style={{
              fontFamily: 'var(--rt-read)', fontSize: 15.5, lineHeight: 1.85,
              color: prep ? 'var(--rt-green-deep)' : 'var(--rt-ink-2)',
            }}>{s.text}</div>
          </div>
        );
      })}

      {terms && terms.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 9, marginTop: 4 }}>
          {terms.map((t, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '88px 1fr', gap: 12, alignItems: 'baseline' }}>
              <span style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--rt-green-deep)' }}>{t.term}</span>
              <span style={{ fontFamily: 'var(--rt-read)', fontSize: 14, lineHeight: 1.7, color: 'var(--rt-ink-2)' }}>{t.gloss}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
