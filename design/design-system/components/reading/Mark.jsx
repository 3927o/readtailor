import React from 'react';

/**
 * Mark — an inline annotation anchor inside running text. The three
 * underline styles distinguish the note types at a glance, even before
 * you tap: dotted=释义(gloss), dashed=推理补全(fillin), wavy=脉络(margin).
 * Hover/active gets a soft-green wash. Pass `onActivate` to open a popover.
 */
export function Mark({ children, type = 'gloss', active = false, onActivate, style, ...rest }) {
  const deco = {
    gloss:  { textDecoration: 'underline dotted var(--rt-mark-gloss, #2F6A52)' },
    fillin: { textDecoration: 'underline dashed var(--rt-mark-fillin, #5b73a8)' },
    margin: { textDecoration: 'underline wavy var(--rt-mark-margin, #b08848)', textDecorationThickness: 1, textUnderlineOffset: 3 },
  };
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate && onActivate(e); } }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--rt-green-soft)'; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
      style={{
        cursor: 'pointer',
        textUnderlineOffset: 4,
        textDecorationThickness: 1.5,
        borderRadius: 2,
        padding: '0 1px',
        background: active ? 'var(--rt-green-soft)' : 'transparent',
        transition: 'background 140ms',
        ...deco[type],
        ...style,
      }}
      {...rest}
    >
      {children}
    </span>
  );
}
