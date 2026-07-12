import React from 'react';

/**
 * Toast — a quiet passing note ("已加入书架", "批注已保存"). A small
 * frosted pill, bottom-centre, serif text, optional green ✦ or dot.
 * Fades + rises in on the brand curve; no slide-from-edge drama.
 */
export function Toast({
  children,
  visible = true,
  accent = false,
  style,
  ...rest
}) {
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 32,
        transform: `translateX(-50%) translateY(${visible ? 0 : 8}px)`,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        transition: 'opacity 240ms cubic-bezier(.2,.7,.2,1), transform 240ms cubic-bezier(.2,.7,.2,1)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '10px 18px',
        borderRadius: 999,
        border: '1px solid var(--rt-rule)',
        background: 'color-mix(in srgb, var(--rt-bg-card) 88%, transparent)',
        backdropFilter: 'saturate(150%) blur(10px)',
        WebkitBackdropFilter: 'saturate(150%) blur(10px)',
        boxShadow: '0 6px 24px -16px rgba(20,40,30,0.25)',
        fontFamily: 'var(--rt-serif)',
        fontSize: 13.5,
        color: 'var(--rt-ink)',
        whiteSpace: 'nowrap',
        zIndex: 60,
        ...style,
      }}
      {...rest}
    >
      {accent ? (
        <span aria-hidden="true" style={{ color: 'var(--rt-green)', fontSize: 11 }}>✦</span>
      ) : (
        <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--rt-green)', flex: 'none' }}></span>
      )}
      {children}
    </div>
  );
}
