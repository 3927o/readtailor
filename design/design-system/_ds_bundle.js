/* @ds-bundle: {"format":4,"namespace":"ReadTailorDesignSystem_39423e","components":[{"name":"BottomNav","sourcePath":"components/chrome/BottomNav.jsx"},{"name":"Masthead","sourcePath":"components/chrome/Masthead.jsx"},{"name":"NavDots","sourcePath":"components/chrome/NavDots.jsx"},{"name":"PhoneFrame","sourcePath":"components/chrome/PhoneFrame.jsx"},{"name":"ProgressBar","sourcePath":"components/chrome/ProgressBar.jsx"},{"name":"ReaderToolbar","sourcePath":"components/chrome/ReaderToolbar.jsx"},{"name":"TOCList","sourcePath":"components/chrome/TOCList.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Chip","sourcePath":"components/core/Chip.jsx"},{"name":"EmptyState","sourcePath":"components/core/EmptyState.jsx"},{"name":"Kicker","sourcePath":"components/core/Kicker.jsx"},{"name":"Segmented","sourcePath":"components/core/Segmented.jsx"},{"name":"Slider","sourcePath":"components/core/Slider.jsx"},{"name":"TextField","sourcePath":"components/core/TextField.jsx"},{"name":"Toast","sourcePath":"components/core/Toast.jsx"},{"name":"Toggle","sourcePath":"components/core/Toggle.jsx"},{"name":"BookCover","sourcePath":"components/library/BookCover.jsx"},{"name":"BookListItem","sourcePath":"components/library/BookListItem.jsx"},{"name":"SearchField","sourcePath":"components/library/SearchField.jsx"},{"name":"ShelfGrid","sourcePath":"components/library/ShelfGrid.jsx"},{"name":"AnnotationCard","sourcePath":"components/reading/AnnotationCard.jsx"},{"name":"BriefCard","sourcePath":"components/reading/BriefCard.jsx"},{"name":"Mark","sourcePath":"components/reading/Mark.jsx"}],"sourceHashes":{"components/chrome/BottomNav.jsx":"a8744fedb5df","components/chrome/Masthead.jsx":"fd02a6508307","components/chrome/NavDots.jsx":"0778622dc622","components/chrome/PhoneFrame.jsx":"7173afb6d66c","components/chrome/ProgressBar.jsx":"8cabbccbc2c0","components/chrome/ReaderToolbar.jsx":"1e9516d3f95e","components/chrome/TOCList.jsx":"40c021717bae","components/core/Button.jsx":"ab29994a3e09","components/core/Chip.jsx":"a6dc29809976","components/core/EmptyState.jsx":"3aa2115e836f","components/core/Kicker.jsx":"f2aa2c4c6e6c","components/core/Segmented.jsx":"ab614f9b05b6","components/core/Slider.jsx":"e931b84ec444","components/core/TextField.jsx":"ba5a6d558306","components/core/Toast.jsx":"7e3190fcfdd5","components/core/Toggle.jsx":"909a5d86b430","components/library/BookCover.jsx":"0e69f6e65205","components/library/BookListItem.jsx":"68ae00cbbf72","components/library/SearchField.jsx":"38dc4b3b2e72","components/library/ShelfGrid.jsx":"b461af664f60","components/reading/AnnotationCard.jsx":"4bbe697c884f","components/reading/BriefCard.jsx":"dc2bf2ca9d7b","components/reading/Mark.jsx":"01f93af43b64","ui_kits/reader/AiPanel.jsx":"3fe1f3bbe748","ui_kits/reader/ReaderApp.jsx":"a0292988d1a0","ui_kits/reader/reader-data.js":"6d88cb238cad"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.ReadTailorDesignSystem_39423e = window.ReadTailorDesignSystem_39423e || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/chrome/BottomNav.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * BottomNav — the app's三格底部导航 (书架 / 发现 / 我的). A frosted bar
 * (the dot-nav's "frosted cover" language) with word labels — no icons.
 * Selected tab: ink text + a small green dot above; others muted.
 */
function BottomNav({
  items = [{
    value: 'shelf',
    label: '书架'
  }, {
    value: 'discover',
    label: '发现'
  }, {
    value: 'me',
    label: '我的'
  }],
  value,
  onChange,
  fixed = true,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("nav", _extends({
    style: {
      position: fixed ? 'fixed' : 'relative',
      left: 0,
      right: 0,
      bottom: 0,
      display: 'flex',
      justifyContent: 'space-around',
      alignItems: 'stretch',
      borderTop: '1px solid var(--rt-rule-2)',
      background: 'color-mix(in srgb, var(--rt-bg) 86%, transparent)',
      backdropFilter: 'saturate(150%) blur(10px)',
      WebkitBackdropFilter: 'saturate(150%) blur(10px)',
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      zIndex: 40,
      ...style
    }
  }, rest), items.map(it => {
    const sel = it.value === value;
    return /*#__PURE__*/React.createElement("button", {
      key: it.value,
      type: "button",
      "aria-current": sel ? 'page' : undefined,
      onClick: () => onChange && onChange(it.value),
      onMouseEnter: e => {
        if (!sel) e.currentTarget.style.color = 'var(--rt-ink)';
      },
      onMouseLeave: e => {
        if (!sel) e.currentTarget.style.color = 'var(--rt-ink-3)';
      },
      style: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        padding: '10px 0 12px',
        minHeight: 52,
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        fontFamily: 'var(--rt-serif)',
        fontSize: 13,
        fontWeight: sel ? 600 : 400,
        letterSpacing: '0.12em',
        color: sel ? 'var(--rt-ink)' : 'var(--rt-ink-3)',
        transition: 'color 160ms'
      }
    }, /*#__PURE__*/React.createElement("span", {
      "aria-hidden": "true",
      style: {
        width: 4,
        height: 4,
        borderRadius: '50%',
        background: sel ? 'var(--rt-green)' : 'transparent',
        transition: 'background 160ms'
      }
    }), it.label);
  }));
}
Object.assign(__ds_scope, { BottomNav });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/chrome/BottomNav.jsx", error: String((e && e.message) || e) }); }

// components/chrome/Masthead.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Masthead — the editorial top bar. A serif wordmark on the left, a mono
 * issue line on the right, a hairline rule below, and a frosted-glass
 * backdrop. The fixed "this is a letter, with a cover" frame.
 */
function Masthead({
  brand = '裁读',
  brandEn = 'ReadTailor',
  issue,
  fixed = true,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("nav", _extends({
    style: {
      ...(fixed ? {
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 100
      } : {}),
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      padding: '18px clamp(22px,5vw,48px) 14px',
      background: 'color-mix(in srgb, var(--rt-bg) 86%, transparent)',
      backdropFilter: 'var(--rt-glass, saturate(150%) blur(10px))',
      WebkitBackdropFilter: 'var(--rt-glass, saturate(150%) blur(10px))',
      borderBottom: '1px solid var(--rt-rule)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 19,
      fontWeight: 700,
      letterSpacing: '-0.01em',
      color: 'var(--rt-ink)'
    }
  }, brand, brandEn && /*#__PURE__*/React.createElement("em", {
    style: {
      fontStyle: 'italic',
      fontWeight: 400,
      color: 'var(--rt-ink-2)',
      marginLeft: 8,
      fontSize: 12,
      letterSpacing: '0.14em'
    }
  }, brandEn)), issue && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 10,
      letterSpacing: '0.22em',
      textTransform: 'uppercase',
      color: 'var(--rt-ink-3)'
    }
  }, issue));
}
Object.assign(__ds_scope, { Masthead });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/chrome/Masthead.jsx", error: String((e && e.message) || e) }); }

// components/chrome/NavDots.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * NavDots — the minimal page-dot navigator that floats at the bottom of
 * the landing. The current dot stretches into a green pill with a soft
 * halo; passed dots are faded green; a `special` dot rotates 45° into a
 * diamond (used for the closing vision page).
 */
function NavDots({
  count = 0,
  current = 0,
  specialIndex = -1,
  onJump,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("nav", _extends({
    "aria-label": "page navigation",
    style: {
      display: 'inline-flex',
      gap: 7,
      alignItems: 'center',
      padding: '6px 11px',
      borderRadius: 999,
      background: 'rgba(250,250,246,0.72)',
      backdropFilter: 'blur(6px)',
      ...style
    }
  }, rest), Array.from({
    length: count
  }).map((_, i) => {
    const isCurrent = i === current;
    const isPast = i < current;
    const special = i === specialIndex;
    const base = {
      width: 6,
      height: 6,
      borderRadius: '50%',
      padding: 0,
      border: 'none',
      cursor: 'pointer',
      transition: 'all 220ms var(--rt-ease)',
      background: isCurrent ? 'var(--rt-green)' : isPast ? 'rgba(47,106,82,0.4)' : 'rgba(10,10,9,0.18)'
    };
    const currentExtra = isCurrent && !special ? {
      width: 16,
      borderRadius: 4,
      boxShadow: '0 0 0 3px rgba(47,106,82,0.12)'
    } : {};
    const specialExtra = special ? {
      transform: 'rotate(45deg)',
      borderRadius: 1,
      ...(isCurrent ? {
        width: 8,
        height: 8
      } : {})
    } : {};
    return /*#__PURE__*/React.createElement("button", {
      key: i,
      type: "button",
      "aria-label": `page ${i + 1}`,
      "aria-current": isCurrent ? 'true' : undefined,
      onClick: () => onJump && onJump(i),
      style: {
        ...base,
        ...currentExtra,
        ...specialExtra
      }
    });
  }));
}
Object.assign(__ds_scope, { NavDots });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/chrome/NavDots.jsx", error: String((e && e.message) || e) }); }

// components/chrome/PhoneFrame.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * PhoneFrame — the dark device shell that holds the reading app in demos.
 * Charcoal body, big radius, notch + home bar, soft layered shadow. Its
 * interior re-points the serif/mono tokens to the UI sans (the "product
 * voice"), so anything inside speaks Glow Sans automatically.
 */
function PhoneFrame({
  children,
  width = 280,
  height = 560,
  style,
  screenStyle,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      width,
      height,
      boxSizing: 'border-box',
      background: '#1A1916',
      borderRadius: 'var(--rt-radius-phone, 38px)',
      padding: 11,
      position: 'relative',
      boxShadow: 'var(--rt-shadow-phone, 0 1px 2px rgba(0,0,0,0.1), 0 30px 60px -30px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.06))',
      // re-point the type tokens → product-UI voice for everything inside
      ['--rt-serif']: 'var(--rt-demo)',
      ['--rt-mono']: 'var(--rt-demo)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    "aria-hidden": "true",
    style: {
      position: 'absolute',
      top: 15,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 58,
      height: 17,
      background: '#1A1916',
      borderRadius: 999,
      zIndex: 5
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--rt-bg)',
      borderRadius: 'var(--rt-radius-screen, 28px)',
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      position: 'relative',
      ...screenStyle
    }
  }, children), /*#__PURE__*/React.createElement("div", {
    "aria-hidden": "true",
    style: {
      position: 'absolute',
      bottom: 7,
      left: '50%',
      transform: 'translateX(-50%)',
      width: 108,
      height: 4,
      background: 'var(--rt-ink)',
      borderRadius: 999,
      opacity: 0.35
    }
  }));
}
Object.assign(__ds_scope, { PhoneFrame });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/chrome/PhoneFrame.jsx", error: String((e && e.message) || e) }); }

// components/chrome/ProgressBar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * ProgressBar — the thin reading-progress sliver pinned to the top of the
 * viewport. A green fill on a transparent track, optional gradient.
 */
function ProgressBar({
  value = 0,
  gradient = false,
  height = 3,
  style,
  ...rest
}) {
  const pct = Math.max(0, Math.min(100, value));
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "progressbar",
    "aria-valuenow": Math.round(pct),
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    style: {
      position: 'fixed',
      top: 0,
      left: 0,
      zIndex: 120,
      height,
      width: `${pct}%`,
      background: gradient ? 'linear-gradient(90deg, var(--rt-green), var(--rt-green-deep))' : 'var(--rt-green)',
      transition: 'width 100ms linear',
      ...style
    }
  }, rest));
}
Object.assign(__ds_scope, { ProgressBar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/chrome/ProgressBar.jsx", error: String((e && e.message) || e) }); }

// components/chrome/ReaderToolbar.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * ReaderToolbar — the reader's frosted top bar. Left: back ‹ + serif
 * book title; right: unicode-glyph actions (≡ 目录, Aa 设置, ✦ AI).
 * Meant to auto-hide while reading; show on tap. The 2px green
 * ProgressBar sits above it (compose separately).
 */
function ReaderToolbar({
  title,
  onBack,
  actions = [],
  fixed = true,
  style,
  ...rest
}) {
  const glyphBtn = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 44,
    minHeight: 44,
    border: 'none',
    background: 'transparent',
    cursor: 'pointer',
    fontFamily: 'var(--rt-demo)',
    fontSize: 15,
    color: 'var(--rt-ink-2)',
    transition: 'color 160ms',
    padding: 0
  };
  const hover = e => {
    e.currentTarget.style.color = 'var(--rt-ink)';
  };
  const leave = e => {
    e.currentTarget.style.color = 'var(--rt-ink-2)';
  };
  return /*#__PURE__*/React.createElement("header", _extends({
    style: {
      position: fixed ? 'fixed' : 'relative',
      top: 0,
      left: 0,
      right: 0,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '0 8px',
      paddingTop: 'env(safe-area-inset-top, 0px)',
      minHeight: 52,
      borderBottom: '1px solid var(--rt-rule-2)',
      background: 'color-mix(in srgb, var(--rt-bg) 86%, transparent)',
      backdropFilter: 'saturate(150%) blur(10px)',
      WebkitBackdropFilter: 'saturate(150%) blur(10px)',
      zIndex: 40,
      boxSizing: 'border-box',
      ...style
    }
  }, rest), onBack ? /*#__PURE__*/React.createElement("button", {
    type: "button",
    "aria-label": "\u8FD4\u56DE",
    onClick: onBack,
    onMouseEnter: hover,
    onMouseLeave: leave,
    style: {
      ...glyphBtn,
      fontFamily: 'var(--rt-serif)',
      fontSize: 18
    }
  }, "\u2039") : null, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      fontFamily: 'var(--rt-serif)',
      fontSize: 14,
      fontWeight: 500,
      letterSpacing: '0.06em',
      color: 'var(--rt-ink)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, title), actions.map((a, i) => /*#__PURE__*/React.createElement("button", {
    key: i,
    type: "button",
    "aria-label": a.label,
    onClick: a.onClick,
    onMouseEnter: hover,
    onMouseLeave: leave,
    style: {
      ...glyphBtn,
      color: a.glyph === '✦' ? 'var(--rt-green)' : glyphBtn.color
    }
  }, a.glyph)));
}
Object.assign(__ds_scope, { ReaderToolbar });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/chrome/ReaderToolbar.jsx", error: String((e && e.message) || e) }); }

// components/chrome/TOCList.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * TOCList — the table-of-contents (目录) list for the reader drawer.
 * Serif chapter titles, mono numerals, hairline separators. The current
 * chapter carries the signature 2px green left edge + soft wash; read
 * chapters are muted.
 */
function TOCList({
  chapters = [],
  current,
  onSelect,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "list",
    style: {
      display: 'flex',
      flexDirection: 'column',
      ...style
    }
  }, rest), chapters.map((ch, i) => {
    const isCurrent = (ch.id ?? i) === current;
    const done = !!ch.read && !isCurrent;
    return /*#__PURE__*/React.createElement("button", {
      key: ch.id ?? i,
      type: "button",
      role: "listitem",
      "aria-current": isCurrent ? 'true' : undefined,
      onClick: () => onSelect && onSelect(ch.id ?? i),
      onMouseEnter: e => {
        if (!isCurrent) e.currentTarget.style.background = 'var(--rt-green-soft)';
      },
      onMouseLeave: e => {
        if (!isCurrent) e.currentTarget.style.background = 'transparent';
      },
      style: {
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
        transition: 'background 160ms'
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: 'var(--rt-mono)',
        fontSize: 9,
        letterSpacing: '0.14em',
        color: isCurrent ? 'var(--rt-green)' : 'var(--rt-ink-3)',
        minWidth: 22,
        flex: 'none'
      }
    }, String(i + 1).padStart(2, '0')), /*#__PURE__*/React.createElement("span", {
      style: {
        flex: 1,
        minWidth: 0,
        fontFamily: 'var(--rt-serif)',
        fontSize: 14.5,
        fontWeight: isCurrent ? 600 : 400,
        lineHeight: 1.6,
        color: isCurrent ? 'var(--rt-ink)' : done ? 'var(--rt-ink-3)' : 'var(--rt-ink-2)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap'
      }
    }, ch.title), done ? /*#__PURE__*/React.createElement("span", {
      "aria-label": "\u5DF2\u8BFB",
      style: {
        fontFamily: 'var(--rt-mono)',
        fontSize: 9,
        letterSpacing: '0.12em',
        color: 'var(--rt-ink-3)',
        flex: 'none'
      }
    }, "READ") : null);
  }));
}
Object.assign(__ds_scope, { TOCList });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/chrome/TOCList.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Button — ReadTailor's primary action. A serif-labelled green pill by
 * default; quieter outline and ghost variants for secondary actions.
 * Green is the brand's only fill, so reserve `primary` for the one real
 * call-to-action on a view.
 */
function Button({
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  disabled = false,
  onClick,
  style,
  ...rest
}) {
  const pads = {
    sm: '8px 16px',
    md: '11px 22px',
    lg: '14px 28px'
  };
  const fontSizes = {
    sm: 13,
    md: 14,
    lg: 16
  };
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    fontFamily: "var(--rt-serif)",
    fontSize: fontSizes[size],
    fontWeight: 500,
    lineHeight: 1,
    padding: pads[size],
    borderRadius: 'var(--rt-radius-pill, 999px)',
    border: '1px solid transparent',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    transition: 'background 160ms, color 160ms, border-color 160ms',
    whiteSpace: 'nowrap',
    WebkitFontSmoothing: 'antialiased'
  };
  const variants = {
    primary: {
      background: 'var(--rt-green)',
      color: 'var(--rt-bg)'
    },
    secondary: {
      background: 'transparent',
      color: 'var(--rt-green-deep)',
      borderColor: 'var(--rt-green)'
    },
    ghost: {
      background: 'transparent',
      color: 'var(--rt-ink-2)',
      borderColor: 'var(--rt-rule)'
    }
  };
  const hoverEnter = e => {
    if (disabled) return;
    if (variant === 'primary') e.currentTarget.style.background = 'var(--rt-green-deep)';else if (variant === 'secondary') e.currentTarget.style.background = 'var(--rt-green-soft)';else {
      e.currentTarget.style.color = 'var(--rt-ink)';
      e.currentTarget.style.borderColor = 'var(--rt-ink-3)';
    }
  };
  const hoverLeave = e => {
    if (disabled) return;
    Object.assign(e.currentTarget.style, variants[variant]);
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    disabled: disabled,
    onClick: onClick,
    onMouseEnter: hoverEnter,
    onMouseLeave: hoverLeave,
    style: {
      ...base,
      ...variants[variant],
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Chip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Chip — a pill toggle. The product's controls (book picker, "卡在哪 /
 * 想拿到" questions) and the brief's profile tags are all chips. Selected
 * state is a soft-green wash + green border; the resting state is a quiet
 * hairline outline. Labelled in the UI sans by default.
 */
function Chip({
  children,
  selected = false,
  as = 'button',
  serif = false,
  onClick,
  style,
  ...rest
}) {
  const Tag = as;
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    flex: 'none',
    whiteSpace: 'nowrap',
    fontFamily: serif ? 'var(--rt-serif)' : 'var(--rt-demo)',
    fontSize: 12.5,
    fontWeight: selected ? 600 : 400,
    padding: '7px 13px',
    borderRadius: 'var(--rt-radius-pill, 999px)',
    border: '1px solid',
    cursor: Tag === 'button' ? 'pointer' : 'default',
    transition: 'color 160ms, background 160ms, border-color 160ms',
    color: selected ? 'var(--rt-green-deep)' : 'var(--rt-ink-2)',
    background: selected ? 'var(--rt-green-soft)' : 'transparent',
    borderColor: selected ? 'var(--rt-green)' : 'var(--rt-rule)'
  };
  const enter = e => {
    if (selected || Tag !== 'button') return;
    e.currentTarget.style.color = 'var(--rt-ink)';
    e.currentTarget.style.borderColor = 'var(--rt-ink-3)';
  };
  const leave = e => {
    if (selected || Tag !== 'button') return;
    e.currentTarget.style.color = 'var(--rt-ink-2)';
    e.currentTarget.style.borderColor = 'var(--rt-rule)';
  };
  return /*#__PURE__*/React.createElement(Tag, _extends({
    onClick: onClick,
    "aria-selected": Tag === 'button' ? selected : undefined,
    onMouseEnter: enter,
    onMouseLeave: leave,
    style: {
      ...base,
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Chip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Chip.jsx", error: String((e && e.message) || e) }); }

// components/core/EmptyState.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * EmptyState — the quiet empty shelf. Letter voice: a short serif line,
 * a muted explanation, optionally one action. Marked by the ⌜ ⌟
 * quote-corners, not an illustration.
 */
function EmptyState({
  title = '这里还空着',
  children,
  action,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 14,
      padding: '56px 24px',
      textAlign: 'center',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    "aria-hidden": "true",
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 22,
      color: 'var(--rt-ink-3)',
      letterSpacing: '0.3em'
    }
  }, "\u231C \u231F"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 17,
      fontWeight: 600,
      color: 'var(--rt-ink)',
      letterSpacing: '0.04em'
    }
  }, title), children ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 13.5,
      lineHeight: 1.9,
      color: 'var(--rt-ink-3)',
      maxWidth: '30ch'
    }
  }, children) : null, action ? /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 6
    }
  }, action) : null);
}
Object.assign(__ds_scope, { EmptyState });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/EmptyState.jsx", error: String((e && e.message) || e) }); }

// components/core/Kicker.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Kicker — the magazine column-head. Mono, uppercase, wide-tracked, with
 * a leading 28px green rule. Sits above headings to label a section
 * ("问题 · The Problem"). The bilingual CN · EN pattern is idiomatic.
 */
function Kicker({
  children,
  as = 'span',
  center = false,
  style,
  ...rest
}) {
  const Tag = as;
  return /*#__PURE__*/React.createElement(Tag, _extends({
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: center ? 'center' : 'flex-start',
      gap: 12,
      fontFamily: 'var(--rt-mono)',
      fontSize: 10,
      letterSpacing: '0.2em',
      textTransform: 'uppercase',
      color: 'var(--rt-green)',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      width: 28,
      height: 1,
      background: 'var(--rt-green)',
      flex: 'none'
    }
  }), children);
}
Object.assign(__ds_scope, { Kicker });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Kicker.jsx", error: String((e && e.message) || e) }); }

// components/core/Segmented.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Segmented — a 2–4 option segmented control (主题 纸白/纸黄/夜间, 视图
 * 网格/列表). A hairline pill track; the selected segment gets the
 * soft-green wash + green text. Sans voice, quiet.
 */
function Segmented({
  options = [],
  value,
  onChange,
  label,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "radiogroup",
    "aria-label": label,
    style: {
      display: 'inline-flex',
      gap: 2,
      padding: 2,
      border: '1px solid var(--rt-rule)',
      borderRadius: 999,
      background: 'var(--rt-bg)',
      ...style
    }
  }, rest), options.map(opt => {
    const o = typeof opt === 'string' ? {
      value: opt,
      label: opt
    } : opt;
    const sel = o.value === value;
    return /*#__PURE__*/React.createElement("button", {
      key: o.value,
      type: "button",
      role: "radio",
      "aria-checked": sel,
      onClick: () => onChange && onChange(o.value),
      onMouseEnter: e => {
        if (!sel) e.currentTarget.style.color = 'var(--rt-ink)';
      },
      onMouseLeave: e => {
        if (!sel) e.currentTarget.style.color = 'var(--rt-ink-3)';
      },
      style: {
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
        whiteSpace: 'nowrap'
      }
    }, o.label);
  }));
}
Object.assign(__ds_scope, { Segmented });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Segmented.jsx", error: String((e && e.message) || e) }); }

// components/core/Slider.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Slider — a hairline range control for reader settings (字号 / 行距 /
 * 批注密度). A 2px track (echoing the progress sliver) with a small
 * round thumb; the filled side is green. Optional mono value readout.
 */
function Slider({
  value = 50,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  label,
  showValue = false,
  format,
  disabled = false,
  style,
  ...rest
}) {
  const pct = (value - min) / (max - min || 1) * 100;
  const id = React.useId();
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      opacity: disabled ? 0.45 : 1,
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      flex: 1,
      height: 24,
      display: 'flex',
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    "aria-hidden": "true",
    style: {
      position: 'absolute',
      left: 0,
      right: 0,
      height: 2,
      borderRadius: 999,
      background: 'var(--rt-rule-2)'
    }
  }), /*#__PURE__*/React.createElement("div", {
    "aria-hidden": "true",
    style: {
      position: 'absolute',
      left: 0,
      width: `${pct}%`,
      height: 2,
      borderRadius: 999,
      background: 'var(--rt-green)'
    }
  }), /*#__PURE__*/React.createElement("input", {
    id: id,
    type: "range",
    min: min,
    max: max,
    step: step,
    value: value,
    disabled: disabled,
    "aria-label": label,
    onChange: e => onChange && onChange(Number(e.target.value)),
    style: {
      position: 'absolute',
      inset: 0,
      width: '100%',
      margin: 0,
      opacity: 0,
      cursor: disabled ? 'default' : 'pointer'
    }
  }), /*#__PURE__*/React.createElement("div", {
    "aria-hidden": "true",
    style: {
      position: 'absolute',
      left: `calc(${pct}% - 8px)`,
      width: 16,
      height: 16,
      borderRadius: '50%',
      background: 'var(--rt-bg-card)',
      border: '1px solid var(--rt-green)',
      boxShadow: '0 1px 3px rgba(10,10,9,0.15)',
      pointerEvents: 'none',
      transition: 'left 60ms linear'
    }
  })), showValue ? /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 10,
      letterSpacing: '0.1em',
      color: 'var(--rt-ink-3)',
      minWidth: 34,
      textAlign: 'right',
      flex: 'none'
    }
  }, format ? format(value) : value) : null);
}
Object.assign(__ds_scope, { Slider });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Slider.jsx", error: String((e && e.message) || e) }); }

// components/core/TextField.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * TextField — a quiet boxed input for forms (昵称, 提问框之外的输入).
 * Hairline border, asymmetric 0 4px 4px 0 radius, green border on
 * focus; brick-red only for errors. Supports multiline.
 */
function TextField({
  value,
  onChange,
  label,
  placeholder,
  error,
  multiline = false,
  rows = 3,
  style,
  inputStyle,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  const id = React.useId();
  const borderColor = error ? 'var(--rt-error)' : focus ? 'var(--rt-green)' : 'var(--rt-rule)';
  const shared = {
    width: '100%',
    boxSizing: 'border-box',
    border: `1px solid ${borderColor}`,
    borderRadius: '0 4px 4px 0',
    background: 'var(--rt-bg-card)',
    fontFamily: 'var(--rt-demo)',
    fontSize: 14,
    lineHeight: 1.6,
    color: 'var(--rt-ink)',
    padding: '10px 12px',
    outline: 'none',
    transition: 'border-color 160ms',
    resize: multiline ? 'vertical' : undefined,
    ...inputStyle
  };
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 7,
      ...style
    }
  }, rest), label ? /*#__PURE__*/React.createElement("label", {
    htmlFor: id,
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 9,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      color: error ? 'var(--rt-error)' : 'var(--rt-ink-3)'
    }
  }, label) : null, multiline ? /*#__PURE__*/React.createElement("textarea", {
    id: id,
    rows: rows,
    value: value,
    onChange: onChange,
    placeholder: placeholder,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: shared
  }) : /*#__PURE__*/React.createElement("input", {
    id: id,
    type: "text",
    value: value,
    onChange: onChange,
    placeholder: placeholder,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    style: shared
  }), error ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-demo)',
      fontSize: 12,
      color: 'var(--rt-error)'
    }
  }, error) : null);
}
Object.assign(__ds_scope, { TextField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/TextField.jsx", error: String((e && e.message) || e) }); }

// components/core/Toast.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Toast — a quiet passing note ("已加入书架", "批注已保存"). A small
 * frosted pill, bottom-centre, serif text, optional green ✦ or dot.
 * Fades + rises in on the brand curve; no slide-from-edge drama.
 */
function Toast({
  children,
  visible = true,
  accent = false,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    role: "status",
    style: {
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
      ...style
    }
  }, rest), accent ? /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      color: 'var(--rt-green)',
      fontSize: 11
    }
  }, "\u2726") : /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      width: 5,
      height: 5,
      borderRadius: '50%',
      background: 'var(--rt-green)',
      flex: 'none'
    }
  }), children);
}
Object.assign(__ds_scope, { Toast });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Toast.jsx", error: String((e && e.message) || e) }); }

// components/core/Toggle.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Toggle — a quiet switch for settings rows (夜间模式, 自动批注…). Off is a
 * hairline pill; on fills sage green. No bounce; 160ms ease.
 */
function Toggle({
  checked = false,
  onChange,
  disabled = false,
  label,
  style,
  ...rest
}) {
  const toggle = () => {
    if (!disabled && onChange) onChange(!checked);
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    type: "button",
    role: "switch",
    "aria-checked": checked,
    "aria-label": label,
    disabled: disabled,
    onClick: toggle,
    style: {
      position: 'relative',
      width: 40,
      height: 24,
      flex: 'none',
      borderRadius: 999,
      border: `1px solid ${checked ? 'var(--rt-green)' : 'var(--rt-rule)'}`,
      background: checked ? 'var(--rt-green)' : 'var(--rt-bg-2)',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.45 : 1,
      padding: 0,
      transition: 'background 160ms, border-color 160ms',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: 2,
      left: checked ? 18 : 2,
      width: 18,
      height: 18,
      borderRadius: '50%',
      background: 'var(--rt-bg-card)',
      boxShadow: '0 1px 3px rgba(10,10,9,0.18)',
      transition: 'left 160ms cubic-bezier(.2,.7,.2,1)'
    }
  }));
}
Object.assign(__ds_scope, { Toggle });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Toggle.jsx", error: String((e && e.message) || e) }); }

// components/library/BookCover.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * BookCover — a typographic placeholder cover. ReadTailor ships no book
 * imagery; covers are set like quiet hardback jackets: warm card, hairline
 * frame, a 2px green spine on the left (the brand's signature edge),
 * vertical-ish serif title, mono author line. Pass `src` when a real
 * cover image exists.
 */
function BookCover({
  title,
  author,
  src,
  size = 'md',
  style,
  ...rest
}) {
  const widths = {
    sm: 72,
    md: 108,
    lg: 148
  };
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
    boxSizing: 'border-box'
  };
  if (src) {
    return /*#__PURE__*/React.createElement("div", _extends({
      style: {
        ...frame,
        ...style
      }
    }, rest), /*#__PURE__*/React.createElement("img", {
      src: src,
      alt: title || '',
      style: {
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        display: 'block'
      }
    }));
  }
  const titleSizes = {
    sm: 12,
    md: 15,
    lg: 19
  };
  const metaSizes = {
    sm: 7,
    md: 8,
    lg: 9
  };
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      ...frame,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      padding: size === 'sm' ? '10px 8px' : '14px 12px',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: titleSizes[size] || titleSizes.md,
      fontWeight: 600,
      lineHeight: 1.45,
      letterSpacing: '0.06em',
      color: 'var(--rt-ink)',
      display: '-webkit-box',
      WebkitLineClamp: 4,
      WebkitBoxOrient: 'vertical',
      overflow: 'hidden'
    }
  }, title), author ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: metaSizes[size] || metaSizes.md,
      letterSpacing: '0.14em',
      textTransform: 'uppercase',
      color: 'var(--rt-ink-3)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, author) : null);
}
Object.assign(__ds_scope, { BookCover });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/library/BookCover.jsx", error: String((e && e.message) || e) }); }

// components/library/BookListItem.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * BookListItem — one row of the bookshelf list: sm cover thumb, serif
 * title, muted meta line, and an optional reading-progress sliver (the
 * 2px green line, echoing the landing's progress bar). Quiet hairline
 * separator below; soft-green wash on hover.
 */
function BookListItem({
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
  return /*#__PURE__*/React.createElement("div", _extends({
    onClick: onClick,
    role: clickable ? 'button' : undefined,
    tabIndex: clickable ? 0 : undefined,
    onKeyDown: clickable ? e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick(e);
      }
    } : undefined,
    onMouseEnter: clickable ? e => {
      e.currentTarget.style.background = 'var(--rt-green-soft)';
    } : undefined,
    onMouseLeave: clickable ? e => {
      e.currentTarget.style.background = 'transparent';
    } : undefined,
    style: {
      display: 'flex',
      gap: 16,
      alignItems: 'center',
      padding: '14px 12px',
      borderBottom: '1px solid var(--rt-rule-2)',
      borderRadius: '0 4px 4px 0',
      cursor: clickable ? 'pointer' : 'default',
      transition: 'background 160ms',
      minHeight: 44,
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement(__ds_scope.BookCover, {
    size: "sm",
    title: title,
    author: author,
    src: src,
    style: {
      boxShadow: 'none'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 0,
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 16,
      fontWeight: 600,
      letterSpacing: '0.02em',
      color: 'var(--rt-ink)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, title), author || meta ? /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-demo)',
      fontSize: 12.5,
      color: 'var(--rt-ink-3)',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis'
    }
  }, [author, meta].filter(Boolean).join(' · ')) : null, typeof progress === 'number' ? /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      marginTop: 2
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      maxWidth: 180,
      height: 2,
      background: 'var(--rt-rule-2)',
      borderRadius: 999,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: `${Math.max(0, Math.min(100, progress))}%`,
      height: '100%',
      background: 'var(--rt-green)',
      transition: 'width 400ms cubic-bezier(.2,.7,.2,1)'
    }
  })), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 9,
      letterSpacing: '0.14em',
      color: 'var(--rt-ink-3)'
    }
  }, Math.round(progress), "%")) : null), clickable ? /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 16,
      color: 'var(--rt-ink-3)',
      flex: 'none'
    }
  }, "\u203A") : null);
}
Object.assign(__ds_scope, { BookListItem });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/library/BookListItem.jsx", error: String((e && e.message) || e) }); }

// components/library/SearchField.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * SearchField — the library's quiet search. Not a boxed SaaS input: a
 * hairline underline that turns green on focus, mono `⌕`-free (we use
 * the word 搜索 or a placeholder instead of an icon). Sans voice.
 */
function SearchField({
  value,
  onChange,
  placeholder = '搜索书名、作者…',
  onSubmit,
  style,
  inputStyle,
  ...rest
}) {
  const [focus, setFocus] = React.useState(false);
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      borderBottom: `1px solid ${focus ? 'var(--rt-green)' : 'var(--rt-rule)'}`,
      transition: 'border-color 160ms',
      padding: '6px 2px',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 9,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      color: focus ? 'var(--rt-green)' : 'var(--rt-ink-3)',
      transition: 'color 160ms',
      flex: 'none'
    }
  }, "SEARCH"), /*#__PURE__*/React.createElement("input", {
    type: "search",
    value: value,
    onChange: onChange,
    placeholder: placeholder,
    onFocus: () => setFocus(true),
    onBlur: () => setFocus(false),
    onKeyDown: e => {
      if (e.key === 'Enter' && onSubmit) onSubmit(e);
    },
    style: {
      flex: 1,
      minWidth: 0,
      border: 'none',
      outline: 'none',
      background: 'transparent',
      fontFamily: 'var(--rt-demo)',
      fontSize: 14,
      color: 'var(--rt-ink)',
      padding: '4px 0',
      ...inputStyle
    }
  }));
}
Object.assign(__ds_scope, { SearchField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/library/SearchField.jsx", error: String((e && e.message) || e) }); }

// components/library/ShelfGrid.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * ShelfGrid — the bookshelf's cover grid. A plain responsive grid with
 * generous gaps; children are usually BookCover (optionally wrapped with
 * a caption). Column width tracks the md cover by default.
 */
function ShelfGrid({
  min = 108,
  gap = 24,
  children,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: 'grid',
      gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`,
      gap,
      justifyItems: 'start',
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { ShelfGrid });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/library/ShelfGrid.jsx", error: String((e && e.message) || e) }); }

// components/reading/AnnotationCard.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
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
function AnnotationCard({
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
  const defaultKicker = {
    lead: '章节导读',
    margin: '脉络',
    fillin: '推理补全 ↳'
  }[kind];
  const head = kicker ?? defaultKicker;
  const shells = {
    lead: {
      background: 'var(--rt-green-soft)',
      borderLeft: '2px solid var(--rt-green)',
      borderRadius: '0 8px 8px 0',
      padding: '15px 18px'
    },
    margin: {
      borderLeft: '1.5px solid var(--rt-rule)',
      padding: '6px 0 4px 12px'
    },
    fillin: {
      background: 'var(--rt-bg-2)',
      borderLeft: '2px dotted var(--rt-ink-3)',
      borderRadius: '0 6px 6px 0',
      padding: '11px 14px'
    }
  };
  const headColor = kind === 'lead' ? 'var(--rt-green)' : kind === 'margin' ? 'var(--rt-ink-3)' : 'var(--rt-ink-3)';
  const bodyColor = kind === 'lead' ? 'var(--rt-green-deep)' : 'var(--rt-ink-2)';
  return /*#__PURE__*/React.createElement("aside", _extends({
    style: {
      margin: '0 0 16px',
      ...shells[kind],
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'baseline',
      gap: 8,
      marginBottom: title || bullets || children ? 8 : 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 9,
      letterSpacing: '0.18em',
      textTransform: 'uppercase',
      fontWeight: 700,
      color: kind === 'lead' ? 'var(--rt-green)' : headColor
    }
  }, head), trigger && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontStyle: 'italic',
      fontSize: 10,
      letterSpacing: '0.04em',
      color: 'var(--rt-ink-3)'
    }
  }, "\u89E6\u53D1 \xB7 ", trigger)), title && /*#__PURE__*/React.createElement("h4", {
    style: {
      margin: '0 0 9px',
      fontFamily: 'var(--rt-serif)',
      fontSize: 16.5,
      fontWeight: 700,
      color: 'var(--rt-green-deep)',
      lineHeight: 1.5
    }
  }, title), kind === 'margin' && anchor && /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 600,
      color: 'var(--rt-green-deep)',
      marginRight: 6,
      fontFamily: 'var(--rt-serif)'
    }
  }, anchor, " \xB7", ' '), bullets && /*#__PURE__*/React.createElement("ul", {
    style: {
      listStyle: 'none',
      margin: 0,
      padding: 0
    }
  }, bullets.map((b, i) => /*#__PURE__*/React.createElement("li", {
    key: i,
    style: {
      position: 'relative',
      paddingLeft: 15,
      marginBottom: 6,
      fontFamily: 'var(--rt-serif)',
      fontSize: 14.5,
      lineHeight: 1.7,
      color: 'var(--rt-green-deep)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      position: 'absolute',
      left: 3,
      fontWeight: 700,
      color: 'var(--rt-green)'
    }
  }, "\xB7"), b))), children && /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 14,
      lineHeight: 1.7,
      color: bodyColor,
      display: 'inline'
    }
  }, children));
}
Object.assign(__ds_scope, { AnnotationCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/reading/AnnotationCard.jsx", error: String((e && e.message) || e) }); }

// components/reading/BriefCard.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * BriefCard — the "读前简报 / read-before-you-start" briefing. A white
 * card that frames a book before the reader opens it: what it is, where
 * it came from, the core terms, and a personalised "how to read it" prep
 * note. The last section can be flagged `prep` to get the green wash.
 */
function BriefCard({
  kicker = '读之前的简报',
  title,
  sections = [],
  terms,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("section", _extends({
    style: {
      background: 'var(--rt-bg-card)',
      border: '1px solid var(--rt-rule)',
      borderRadius: 14,
      padding: '28px 28px 22px',
      boxShadow: 'var(--rt-shadow-card, 0 6px 24px -16px rgba(20,40,30,0.25))',
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: 12,
      marginBottom: 12,
      fontFamily: 'var(--rt-mono)',
      fontSize: 10,
      letterSpacing: '0.2em',
      textTransform: 'uppercase',
      color: 'var(--rt-green)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    "aria-hidden": "true",
    style: {
      width: 28,
      height: 1,
      background: 'var(--rt-green)'
    }
  }), kicker), title && /*#__PURE__*/React.createElement("h2", {
    style: {
      margin: '0 0 18px',
      paddingBottom: 14,
      borderBottom: '1px solid var(--rt-rule-2)',
      fontFamily: 'var(--rt-serif)',
      fontSize: 23,
      fontWeight: 700,
      color: 'var(--rt-ink)'
    }
  }, title), sections.map((s, i) => {
    const prep = !!s.prep;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        marginBottom: 18,
        ...(prep ? {
          background: 'var(--rt-green-soft)',
          borderLeft: '3px solid var(--rt-green)',
          borderRadius: '0 6px 6px 0',
          padding: '14px 16px'
        } : {})
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        fontWeight: 700,
        marginBottom: 5,
        color: prep ? 'var(--rt-green-deep)' : 'var(--rt-ink)'
      }
    }, s.label), /*#__PURE__*/React.createElement("div", {
      style: {
        fontFamily: 'var(--rt-read)',
        fontSize: 15.5,
        lineHeight: 1.85,
        color: prep ? 'var(--rt-green-deep)' : 'var(--rt-ink-2)'
      }
    }, s.text));
  }), terms && terms.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 9,
      marginTop: 4
    }
  }, terms.map((t, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      display: 'grid',
      gridTemplateColumns: '88px 1fr',
      gap: 12,
      alignItems: 'baseline'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: 700,
      fontSize: 14.5,
      color: 'var(--rt-green-deep)'
    }
  }, t.term), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--rt-read)',
      fontSize: 14,
      lineHeight: 1.7,
      color: 'var(--rt-ink-2)'
    }
  }, t.gloss)))));
}
Object.assign(__ds_scope, { BriefCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/reading/BriefCard.jsx", error: String((e && e.message) || e) }); }

// components/reading/Mark.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Mark — an inline annotation anchor inside running text. The three
 * underline styles distinguish the note types at a glance, even before
 * you tap: dotted=释义(gloss), dashed=推理补全(fillin), wavy=脉络(margin).
 * Hover/active gets a soft-green wash. Pass `onActivate` to open a popover.
 */
function Mark({
  children,
  type = 'gloss',
  active = false,
  onActivate,
  style,
  ...rest
}) {
  const deco = {
    gloss: {
      textDecoration: 'underline dotted var(--rt-mark-gloss, #2F6A52)'
    },
    fillin: {
      textDecoration: 'underline dashed var(--rt-mark-fillin, #5b73a8)'
    },
    margin: {
      textDecoration: 'underline wavy var(--rt-mark-margin, #b08848)',
      textDecorationThickness: 1,
      textUnderlineOffset: 3
    }
  };
  return /*#__PURE__*/React.createElement("span", _extends({
    role: "button",
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate && onActivate(e);
      }
    },
    onMouseEnter: e => {
      e.currentTarget.style.background = 'var(--rt-green-soft)';
    },
    onMouseLeave: e => {
      if (!active) e.currentTarget.style.background = 'transparent';
    },
    style: {
      cursor: 'pointer',
      textUnderlineOffset: 4,
      textDecorationThickness: 1.5,
      borderRadius: 2,
      padding: '0 1px',
      background: active ? 'var(--rt-green-soft)' : 'transparent',
      transition: 'background 140ms',
      ...deco[type],
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { Mark });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/reading/Mark.jsx", error: String((e && e.message) || e) }); }

// ui_kits/reader/AiPanel.jsx
try { (() => {
/* ReadTailor · Reader — the slide-in AI companion + the Aa settings popover.
   Both are faked (no real LLM); the AI gives a canned, brand-voiced reply. */

function AiPanel({
  open,
  quote,
  loc,
  onClose
}) {
  const [msgs, setMsgs] = React.useState([]);
  const [draft, setDraft] = React.useState('');
  React.useEffect(() => {
    if (open) {
      setMsgs([]);
      setDraft('');
    }
  }, [open, quote]);
  function ask(text) {
    if (!text.trim()) return;
    const canned = '这句话的字面是在跟太阳说话，但其实是查拉图斯特拉在说他自己——太阳因为有万物接受它的光才幸福，他也一样：攒了十年的智慧，必须被人接收才有意义。这就是他下山的理由。要我再就「下降」这个双关展开一点吗？';
    setMsgs(m => [...m, {
      who: 'user',
      text
    }, {
      who: 'ai',
      text: canned
    }]);
    setDraft('');
  }
  return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    onClick: onClose,
    style: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(20,28,22,0.30)',
      zIndex: 215,
      opacity: open ? 1 : 0,
      pointerEvents: open ? 'auto' : 'none',
      transition: 'opacity 220ms'
    }
  }), /*#__PURE__*/React.createElement("aside", {
    style: {
      position: 'fixed',
      top: 0,
      right: 0,
      height: '100%',
      width: 420,
      maxWidth: '92vw',
      zIndex: 220,
      background: 'var(--rt-bg)',
      borderLeft: '1px solid var(--rt-rule)',
      boxShadow: '0 0 60px -14px rgba(20,40,30,0.5)',
      transform: open ? 'none' : 'translateX(102%)',
      transition: 'transform 280ms cubic-bezier(.4,0,.2,1)',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '16px 18px 13px',
      borderBottom: '1px solid var(--rt-rule)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 16,
      fontWeight: 700,
      color: 'var(--rt-green-deep)'
    }
  }, "\u2726 \u95EE\u95EE AI"), /*#__PURE__*/React.createElement("button", {
    onClick: onClose,
    "aria-label": "\u5173\u95ED",
    style: {
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      fontSize: 22,
      lineHeight: 1,
      color: 'var(--rt-ink-3)'
    }
  }, "\xD7")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 18px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 10,
      letterSpacing: '0.08em',
      color: 'var(--rt-green)',
      marginBottom: 7
    }
  }, loc || '查拉图斯特拉的前言 · 1'), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 14,
      lineHeight: 1.7,
      color: 'var(--rt-ink-2)',
      fontStyle: 'italic',
      background: 'var(--rt-green-soft)',
      borderLeft: '3px solid var(--rt-green)',
      borderRadius: '0 8px 8px 0',
      padding: '11px 14px',
      maxHeight: 124,
      overflow: 'auto'
    }
  }, quote || '如果没有你所照耀的人们，你有何幸福可言哩！')), msgs.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 7,
      padding: '13px 18px 4px'
    }
  }, ['这句/这段在说什么？', '为什么是「下降」？', '他在反驳谁？'].map(q => /*#__PURE__*/React.createElement("button", {
    key: q,
    onClick: () => ask(q),
    style: {
      fontFamily: 'var(--rt-demo)',
      fontSize: 12.5,
      color: 'var(--rt-green-deep)',
      background: 'var(--rt-bg-card)',
      border: '1px solid var(--rt-rule)',
      borderRadius: 999,
      padding: '6px 13px',
      cursor: 'pointer'
    }
  }, q))), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto',
      padding: '14px 18px 8px',
      display: 'flex',
      flexDirection: 'column',
      gap: 14
    }
  }, msgs.map((m, i) => m.who === 'user' ? /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      alignSelf: 'flex-end',
      maxWidth: '85%',
      background: 'var(--rt-green)',
      color: '#fff',
      fontFamily: 'var(--rt-demo)',
      fontSize: 14,
      lineHeight: 1.65,
      padding: '9px 14px',
      borderRadius: '14px 14px 4px 14px'
    }
  }, m.text) : /*#__PURE__*/React.createElement("div", {
    key: i,
    style: {
      alignSelf: 'stretch',
      fontFamily: 'var(--rt-read)',
      fontSize: 15,
      lineHeight: 1.85,
      color: 'var(--rt-ink)'
    }
  }, m.text))), /*#__PURE__*/React.createElement("form", {
    onSubmit: e => {
      e.preventDefault();
      ask(draft);
    },
    style: {
      display: 'flex',
      alignItems: 'flex-end',
      gap: 9,
      padding: '12px 16px 16px',
      borderTop: '1px solid var(--rt-rule)'
    }
  }, /*#__PURE__*/React.createElement("textarea", {
    value: draft,
    onChange: e => setDraft(e.target.value),
    rows: 1,
    onKeyDown: e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        ask(draft);
      }
    },
    placeholder: "\u8FFD\u95EE\u70B9\u4EC0\u4E48\u2026\uFF08Enter \u53D1\u9001\uFF09",
    style: {
      flex: 1,
      resize: 'none',
      fontFamily: 'var(--rt-demo)',
      fontSize: 14,
      lineHeight: 1.5,
      color: 'var(--rt-ink)',
      background: 'var(--rt-bg-card)',
      border: '1px solid var(--rt-rule)',
      borderRadius: 12,
      padding: '10px 13px',
      outline: 'none'
    }
  }), /*#__PURE__*/React.createElement("button", {
    type: "submit",
    "aria-label": "\u53D1\u9001",
    style: {
      flex: 'none',
      width: 38,
      height: 38,
      borderRadius: '50%',
      border: 'none',
      background: 'var(--rt-green)',
      color: '#fff',
      fontSize: 18,
      cursor: 'pointer'
    }
  }, "\u2191"))));
}
function SettingsPopover({
  open,
  settings,
  onChange
}) {
  const seg = (label, key, opts) => /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 15
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 9,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: 'var(--rt-ink-3)',
      marginBottom: 8
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 6
    }
  }, opts.map(([v, l]) => {
    const on = settings[key] === v;
    return /*#__PURE__*/React.createElement("button", {
      key: l,
      onClick: () => onChange(key, v),
      style: {
        flex: 1,
        fontFamily: 'var(--rt-demo)',
        fontSize: 13,
        cursor: 'pointer',
        color: on ? '#fff' : 'var(--rt-ink-2)',
        background: on ? 'var(--rt-green)' : 'var(--rt-bg-2)',
        border: '1px solid transparent',
        borderRadius: 8,
        padding: '7px 0',
        fontWeight: on ? 600 : 400
      }
    }, l);
  })));
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'absolute',
      top: 50,
      right: 0,
      width: 262,
      zIndex: 60,
      background: 'var(--rt-bg-card)',
      border: '1px solid var(--rt-rule)',
      borderRadius: 14,
      boxShadow: '0 18px 40px -14px rgba(25,40,30,0.4)',
      padding: '16px 18px',
      opacity: open ? 1 : 0,
      transform: open ? 'none' : 'translateY(-6px) scale(0.98)',
      transformOrigin: 'top right',
      pointerEvents: open ? 'auto' : 'none',
      transition: 'opacity 160ms, transform 160ms'
    }
  }, seg('字号', 'size', [['16px', '小'], ['', '标准'], ['20px', '大'], ['22px', '特大']]), seg('行距', 'lh', [['1.7', '紧'], ['', '标准'], ['2.25', '松']]), seg('页宽', 'width', [['620px', '窄'], ['', '标准'], ['860px', '宽']]));
}
Object.assign(window, {
  AiPanel,
  SettingsPopover
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/reader/AiPanel.jsx", error: String((e && e.message) || e) }); }

// ui_kits/reader/ReaderApp.jsx
try { (() => {
/* ReadTailor · Reader — the reading view shell.
   Composes the design-system primitives (Mark, AnnotationCard, BriefCard,
   ProgressBar) into the product's "全本陪读" page. */

const DS = window.ReadTailorDesignSystem_39423e;
function ReaderApp() {
  const {
    Mark,
    AnnotationCard,
    BriefCard,
    ProgressBar
  } = DS;
  const brief = window.READER_BRIEF;
  const units = window.READER_UNITS;
  const TYPELABELS = window.READER_TYPELABELS;
  const [progress, setProgress] = React.useState(8);
  const [pop, setPop] = React.useState(null); // {x,y,type,content}
  const [ai, setAi] = React.useState(null); // {quote,loc} | null
  const [setOpen, setSetOpen] = React.useState(false);
  const [settings, setSettings] = React.useState({
    size: '',
    lh: '',
    width: ''
  });
  const [briefOpen, setBriefOpen] = React.useState(true);
  const scrollRef = React.useRef(null);
  function onScroll(e) {
    const el = e.currentTarget;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max > 0 ? el.scrollTop / max * 100 : 0);
    if (pop) setPop(null);
  }
  function openMark(e, seg) {
    const r = e.currentTarget.getBoundingClientRect();
    setPop({
      x: Math.min(r.left, window.innerWidth - 360),
      y: r.bottom + 8,
      type: seg.type,
      content: seg.content,
      anchor: seg.t
    });
  }
  const bodySize = settings.size || '18px';
  const bodyLh = settings.lh || '1.95';
  const wrapW = settings.width || '720px';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      minHeight: '100%',
      background: 'var(--rt-bg)',
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement(ProgressBar, {
    value: progress,
    gradient: true
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      top: 14,
      right: 16,
      zIndex: 130,
      display: 'flex',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement(ToolBtn, {
    onClick: () => {}
  }, "\u2261\xA0\u76EE\u5F55"), /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative'
    }
  }, /*#__PURE__*/React.createElement(ToolBtn, {
    onClick: () => setSetOpen(v => !v),
    active: setOpen
  }, "Aa"), /*#__PURE__*/React.createElement(window.SettingsPopover, {
    open: setOpen,
    settings: settings,
    onChange: (k, v) => setSettings(s => ({
      ...s,
      [k]: v
    }))
  }))), /*#__PURE__*/React.createElement("div", {
    ref: scrollRef,
    onScroll: onScroll,
    style: {
      height: '100vh',
      overflowY: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      maxWidth: wrapW,
      margin: '0 auto',
      padding: '46px 24px 160px',
      transition: 'max-width 200ms'
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      borderBottom: '1px solid var(--rt-rule)',
      paddingBottom: 20,
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 20,
      fontWeight: 700,
      letterSpacing: '-0.01em'
    }
  }, "\u88C1\u8BFB ", /*#__PURE__*/React.createElement("em", {
    style: {
      fontStyle: 'italic',
      fontWeight: 400,
      color: 'var(--rt-ink-2)',
      marginLeft: 8,
      fontSize: 12,
      letterSpacing: '0.14em'
    }
  }, "\xB7 ReadTailor")), /*#__PURE__*/React.createElement("h1", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 34,
      fontWeight: 700,
      margin: '18px 0 6px',
      letterSpacing: '-0.01em'
    }
  }, "\u67E5\u62C9\u56FE\u65AF\u7279\u62C9\u5982\u662F\u8BF4"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 10,
      letterSpacing: '0.2em',
      textTransform: 'uppercase',
      color: 'var(--rt-ink-3)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--rt-green)'
    }
  }, "\xB7"), "\xA0\xA0\u5F17\u91CC\u5FB7\u91CC\u5E0C\xB7\u5C3C\u91C7 \xB7 \u5168\u672C\u966A\u8BFB"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexWrap: 'wrap',
      gap: 7,
      marginTop: 18
    }
  }, brief.profile.map((c, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      background: 'var(--rt-green-soft)',
      color: 'var(--rt-green-deep)',
      borderRadius: 999,
      padding: '5px 12px',
      fontFamily: 'var(--rt-demo)',
      fontSize: 12
    }
  }, c[0], " ", /*#__PURE__*/React.createElement("b", {
    style: {
      fontWeight: 700
    }
  }, c[1]), c[2] || '')))), /*#__PURE__*/React.createElement("div", {
    style: {
      margin: '34px 0 8px'
    }
  }, /*#__PURE__*/React.createElement(BriefCard, {
    title: brief.title,
    sections: briefOpen ? brief.sections.filter(s => !s.terms) : [],
    terms: briefOpen ? (brief.sections.find(s => s.terms) || {}).terms?.map(([term, gloss]) => ({
      term,
      gloss
    })) : []
  }), /*#__PURE__*/React.createElement("button", {
    onClick: () => setBriefOpen(v => !v),
    style: {
      marginTop: 10,
      fontFamily: 'var(--rt-mono)',
      fontSize: 10,
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      color: 'var(--rt-green)',
      background: 'none',
      border: 'none',
      cursor: 'pointer'
    }
  }, briefOpen ? '收起简报 ▲' : '展开简报 ▼')), /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 48
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 10,
      letterSpacing: '0.3em',
      textTransform: 'uppercase',
      color: 'var(--rt-ink-3)',
      textAlign: 'center',
      marginBottom: 8
    }
  }, "\u4E2A \u6027 \u5316 \u94FA \u8DEF \xB7 \u5168 \u672C"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-demo)',
      fontSize: 12.5,
      color: 'var(--rt-ink-3)',
      textAlign: 'center',
      marginBottom: 30
    }
  }, "\u539F\u6587\u4E00\u5B57\u4E0D\u6539 \xB7 \u70B9\u5E26\u865A\u7EBF\u7684\u8BCD/\u53E5\u770B\u6CE8\u91CA\uFF08\u91CA\u4E49 / \u63A8\u7406\u8865\u5168 / \u8109\u7EDC\uFF09"), /*#__PURE__*/React.createElement("h2", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 30,
      fontWeight: 700,
      textAlign: 'center',
      margin: '30px 0 8px'
    }
  }, "\u7B2C\u4E00\u90E8"), /*#__PURE__*/React.createElement("h3", {
    style: {
      fontFamily: 'var(--rt-serif)',
      fontSize: 21,
      fontWeight: 700,
      color: 'var(--rt-green-deep)',
      margin: '44px 0 6px',
      textAlign: 'center'
    }
  }, "\u67E5\u62C9\u56FE\u65AF\u7279\u62C9\u7684\u524D\u8A00"), units.map((u, ui) => /*#__PURE__*/React.createElement("section", {
    key: ui,
    style: {
      margin: '30px 0'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 10,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      color: 'var(--rt-green)',
      borderTop: '1px solid var(--rt-rule-2)',
      paddingTop: 22,
      marginBottom: 14
    }
  }, u.no), /*#__PURE__*/React.createElement(AnnotationCard, {
    kind: "lead",
    kicker: "\u7AE0\u8282\u5BFC\u8BFB \xB7 \u59CB\u7EC8\u5C55\u5F00",
    title: u.lead.title
  }, u.lead.text), u.paras.map((para, pi) => /*#__PURE__*/React.createElement("p", {
    key: pi,
    style: {
      fontFamily: 'var(--rt-read)',
      fontSize: bodySize,
      lineHeight: bodyLh,
      color: 'var(--rt-ink)',
      textIndent: '2em',
      margin: '0 0 14px',
      textAlign: 'justify'
    }
  }, para.map((seg, si) => typeof seg === 'string' ? seg : /*#__PURE__*/React.createElement(Mark, {
    key: si,
    type: seg.type,
    active: pop && pop.anchor === seg.t,
    onActivate: e => openMark(e, seg)
  }, seg.t)))))), /*#__PURE__*/React.createElement("p", {
    style: {
      fontFamily: 'var(--rt-read)',
      fontSize: bodySize,
      lineHeight: bodyLh,
      color: 'var(--rt-ink-3)',
      textAlign: 'center',
      marginTop: 40,
      fontStyle: 'italic'
    }
  }, "\u2026 \u5212\u9009\u4EFB\u610F\u53E5\u5B50\uFF0C\u6216\u70B9\u4E00\u4E2A\u6CE8\u91CA\uFF0C\u5411 AI \u8FFD\u95EE\u3002")))), /*#__PURE__*/React.createElement("button", {
    onClick: () => setAi({
      quote: '如果没有你所照耀的人们，你有何幸福可言哩！',
      loc: '查拉图斯特拉的前言 · 1'
    }),
    style: {
      position: 'fixed',
      left: '50%',
      bottom: 24,
      transform: 'translateX(-50%)',
      zIndex: 80,
      fontFamily: 'var(--rt-demo)',
      fontSize: 14.5,
      fontWeight: 600,
      color: '#fff',
      background: 'var(--rt-green)',
      border: 'none',
      borderRadius: 999,
      padding: '13px 26px',
      cursor: 'pointer',
      boxShadow: '0 12px 34px -8px rgba(31,77,58,0.7)'
    }
  }, "\u2726\xA0\u5C31\u8FD9\u6BB5\u95EE\u95EE AI"), pop && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      left: pop.x,
      top: pop.y,
      zIndex: 100,
      maxWidth: 340,
      minWidth: 220,
      background: 'var(--rt-bg-card)',
      border: '1px solid var(--rt-rule)',
      borderRadius: 11,
      borderTop: `2px solid ${pop.type === 'margin' ? 'var(--rt-mark-margin)' : pop.type === 'fillin' ? 'var(--rt-mark-fillin)' : 'var(--rt-green)'}`,
      padding: '13px 15px 14px',
      boxShadow: 'var(--rt-shadow-pop)',
      fontFamily: 'var(--rt-serif)'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 9,
      letterSpacing: '0.16em',
      textTransform: 'uppercase',
      fontWeight: 700,
      color: pop.type === 'margin' ? 'var(--rt-mark-margin)' : pop.type === 'fillin' ? 'var(--rt-mark-fillin)' : 'var(--rt-green)',
      display: 'block',
      marginBottom: 7
    }
  }, TYPELABELS[pop.type]), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14.5,
      lineHeight: 1.74,
      color: 'var(--rt-ink)'
    }
  }, pop.content), /*#__PURE__*/React.createElement("button", {
    onClick: () => setPop(null),
    style: {
      position: 'absolute',
      top: 8,
      right: 10,
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      color: 'var(--rt-ink-3)',
      fontSize: 16,
      lineHeight: 1
    }
  }, "\xD7")), /*#__PURE__*/React.createElement(window.AiPanel, {
    open: !!ai,
    quote: ai && ai.quote,
    loc: ai && ai.loc,
    onClose: () => setAi(null)
  }));
}
function ToolBtn({
  children,
  onClick,
  active
}) {
  return /*#__PURE__*/React.createElement("button", {
    onClick: onClick,
    style: {
      fontFamily: 'var(--rt-mono)',
      fontSize: 11,
      letterSpacing: '0.06em',
      color: 'var(--rt-green-deep)',
      background: active ? '#fff' : 'rgba(255,255,255,0.86)',
      backdropFilter: 'blur(8px)',
      border: `1px solid ${active ? 'var(--rt-green)' : 'var(--rt-rule)'}`,
      borderRadius: 999,
      padding: '7px 13px',
      cursor: 'pointer',
      boxShadow: '0 4px 14px -8px rgba(20,40,30,0.4)'
    }
  }, children);
}
Object.assign(window, {
  ReaderApp
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/reader/ReaderApp.jsx", error: String((e && e.message) || e) }); }

// ui_kits/reader/reader-data.js
try { (() => {
/* ReadTailor · Reader UI kit — annotation data + reading content.
   A faithful slice of the product's "全本陪读" reading view: the opening
   of 查拉图斯特拉如是说 with the three annotation types in place. */

window.READER_BRIEF = {
  title: '读之前，你需要知道的',
  profile: [['为', '第一次读尼采', '的你'], ['目标 ·', '读懂他在主张什么'], ['替你扫 ·', '比喻 / 绕句 / 整章看不懂'], ['力度 ·', '适中偏密']],
  sections: [{
    label: '这是一本什么书',
    text: '《查拉图斯特拉如是说》这样开场：一位隐者在山中独居十年，带着满心领悟下山布道。他的第一句话，便是那句撼动整个现代的——「上帝死了」。这不是无神论的宣告，而是说：两千年来替人间判定善恶的根基，已经动摇。'
  }, {
    label: '你会反复撞见的几个核心词',
    terms: [['上帝死了', '不是「我宣布无神」的口号，而是一个文化诊断：撑了西方两千年善恶对错的那个根基已经失效。'], ['超人', 'Übermensch。人应当去超越现在的自己。重点在「超越」这个动作，不是某个超级人。'], ['永恒轮回', '一个思想实验：如果这一生每个瞬间都要一模一样地无限重复，你还愿意这样活吗？']]
  }, {
    label: '给你的读法准备（针对你）',
    prep: true,
    text: '先给你吃颗定心丸：这本书没人能一遍读通，读着读着发现整段没跟上，跳过去、或者只带走其中一句话，都完全没问题——它本来就是用来反复读、慢慢回味的，不是用来考试的，卡住不代表你不行。'
  }]
};

// reading units — each paragraph may carry inline marks (gloss/fillin/margin)
// represented as ordered segments: strings, or {t, type, content}.
window.READER_UNITS = [{
  no: '1',
  lead: {
    title: '下山入世：孤独的完成',
    text: '这一节讲查拉图斯特拉在山里隐居十年后，突然决定下山。他对着太阳说话，意思是：太阳的光需要有人来照耀才幸福；同样，他的智慧积得太满，必须有人来接受。主旨是：尼采反对那种只为自己、躲在孤独里玩智慧的哲学家，主张智慧应当像阳光一样流出去。'
  },
  paras: [['查拉图斯特拉三十岁时，离开他的家乡和他家乡的湖，', {
    t: '到山里去',
    type: 'gloss',
    content: '「到山里去」不是字面意义的隐居度假，而是尼采常用的象征：远离人群、远离世俗观念，独自思考。山代表高处、孤独、自由。查拉图斯特拉在山里待了十年，不是逃避，而是在积蓄智慧。'
  }, '。他在那里', {
    t: '安享他的智慧和孤独，十年不倦',
    type: 'gloss',
    content: '「安享」和「不倦」是关键——他不是苦行僧，在山里过得挺爽。真正的思想家不是被迫孤独的可怜虫，而是主动选择孤独，因为孤独让他自由、让他能专心思考。'
  }, '。可是最后，他的心情变了——某日清晨，他跟曙光一同起身，走到太阳面前，对它如是说道：'], ['「你伟大的天体啊！如果没有你所照耀的人们，你有何幸福可言哩！'], ['瞧！', {
    t: '我对我的智慧感到厌腻，就像蜜蜂采集了过多的蜜',
    type: 'fillin',
    content: '蜜蜂采蜜采太多会腻，他的智慧也「满」到让他不舒服了。这不是凡尔赛，而是说：真正的智慧是一种会「胀」的东西，满了就必须给出去，不然自己难受。分享不是牺牲，是本能。'
  }, '，我需要有人伸手来接取智慧。'], ['因此我必须下山，深入人世：如同你每晚所行的，', {
    t: '走下到海的那边',
    type: 'margin',
    content: '太阳每天西沉入海，古人认为它去了地下世界，把光线带给黑暗。尼采借用这个意象，表示查拉图斯特拉要把智慧带进尘世的「黑暗」——那些尚未被启蒙的人心中。'
  }, '，还把你的光带往那下面的世界，你这极度丰饶的天体啊！」'], ['——于是查拉图斯特拉开始下降。']]
}];
window.READER_TYPELABELS = {
  gloss: '释义',
  fillin: '推理补全',
  margin: '脉络'
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/reader/reader-data.js", error: String((e && e.message) || e) }); }

__ds_ns.BottomNav = __ds_scope.BottomNav;

__ds_ns.Masthead = __ds_scope.Masthead;

__ds_ns.NavDots = __ds_scope.NavDots;

__ds_ns.PhoneFrame = __ds_scope.PhoneFrame;

__ds_ns.ProgressBar = __ds_scope.ProgressBar;

__ds_ns.ReaderToolbar = __ds_scope.ReaderToolbar;

__ds_ns.TOCList = __ds_scope.TOCList;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Chip = __ds_scope.Chip;

__ds_ns.EmptyState = __ds_scope.EmptyState;

__ds_ns.Kicker = __ds_scope.Kicker;

__ds_ns.Segmented = __ds_scope.Segmented;

__ds_ns.Slider = __ds_scope.Slider;

__ds_ns.TextField = __ds_scope.TextField;

__ds_ns.Toast = __ds_scope.Toast;

__ds_ns.Toggle = __ds_scope.Toggle;

__ds_ns.BookCover = __ds_scope.BookCover;

__ds_ns.BookListItem = __ds_scope.BookListItem;

__ds_ns.SearchField = __ds_scope.SearchField;

__ds_ns.ShelfGrid = __ds_scope.ShelfGrid;

__ds_ns.AnnotationCard = __ds_scope.AnnotationCard;

__ds_ns.BriefCard = __ds_scope.BriefCard;

__ds_ns.Mark = __ds_scope.Mark;

})();
