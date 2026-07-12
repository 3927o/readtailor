import React from 'react';

/**
 * PhoneFrame — the dark device shell that holds the reading app in demos.
 * Charcoal body, big radius, notch + home bar, soft layered shadow. Its
 * interior re-points the serif/mono tokens to the UI sans (the "product
 * voice"), so anything inside speaks Glow Sans automatically.
 */
export function PhoneFrame({ children, width = 280, height = 560, style, screenStyle, ...rest }) {
  return (
    <div
      style={{
        width, height, boxSizing: 'border-box',
        background: '#1A1916',
        borderRadius: 'var(--rt-radius-phone, 38px)',
        padding: 11,
        position: 'relative',
        boxShadow: 'var(--rt-shadow-phone, 0 1px 2px rgba(0,0,0,0.1), 0 30px 60px -30px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.06))',
        // re-point the type tokens → product-UI voice for everything inside
        ['--rt-serif']: 'var(--rt-demo)',
        ['--rt-mono']: 'var(--rt-demo)',
        ...style,
      }}
      {...rest}
    >
      <div aria-hidden="true" style={{
        position: 'absolute', top: 15, left: '50%', transform: 'translateX(-50%)',
        width: 58, height: 17, background: '#1A1916', borderRadius: 999, zIndex: 5,
      }} />
      <div style={{
        background: 'var(--rt-bg)',
        borderRadius: 'var(--rt-radius-screen, 28px)',
        width: '100%', height: '100%', overflow: 'hidden', position: 'relative',
        ...screenStyle,
      }}>
        {children}
      </div>
      <div aria-hidden="true" style={{
        position: 'absolute', bottom: 7, left: '50%', transform: 'translateX(-50%)',
        width: 108, height: 4, background: 'var(--rt-ink)', borderRadius: 999, opacity: 0.35,
      }} />
    </div>
  );
}
