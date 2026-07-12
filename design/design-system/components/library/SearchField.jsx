import React from 'react';

/**
 * SearchField — the library's quiet search. Not a boxed SaaS input: a
 * hairline underline that turns green on focus, mono `⌕`-free (we use
 * the word 搜索 or a placeholder instead of an icon). Sans voice.
 */
export function SearchField({
  value,
  onChange,
  placeholder = '搜索书名、作者…',
  onSubmit,
  style,
  inputStyle,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderBottom: `1px solid ${focus ? 'var(--rt-green)' : 'var(--rt-rule)'}`,
        transition: 'border-color 160ms',
        padding: '6px 2px',
        ...style,
      }}
      {...rest}
    >
      <span aria-hidden="true" style={{
        fontFamily: 'var(--rt-mono)',
        fontSize: 9,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: focus ? 'var(--rt-green)' : 'var(--rt-ink-3)',
        transition: 'color 160ms',
        flex: 'none',
      }}>
        SEARCH
      </span>
      <input
        type="search"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        onKeyDown={(e) => { if (e.key === 'Enter' && onSubmit) onSubmit(e); }}
        style={{
          flex: 1,
          minWidth: 0,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          fontFamily: 'var(--rt-demo)',
          fontSize: 14,
          color: 'var(--rt-ink)',
          padding: '4px 0',
          ...inputStyle,
        }}
      />
    </div>
  );
}
