---
name: readtailor-design
description: Use this skill to generate well-branded interfaces and assets for ReadTailor (裁读), an AI reading-companion product — either for production or throwaway prototypes/mocks/decks. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping in ReadTailor's editorial "quiet letter" style.
user-invocable: true
---

# ReadTailor 裁读 — design skill

Read **README.md** in this skill first — it holds the full design guide: the "quiet letter" aesthetic, content/voice rules, visual foundations, iconography, and an index of every file. Then explore the files you need.

## What's here
- `styles.css` + `tokens/` — the design tokens and webfont rules. Link `styles.css` and reference `var(--rt-*)`.
- `guidelines/*.card.html` — foundation specimens (color, type, spacing, brand).
- `components/<group>/` — React primitives (core: Button, Chip, Kicker, Toggle, Slider, Segmented, TextField, Toast, EmptyState · reading: AnnotationCard, Mark, BriefCard · library: BookCover, BookListItem, ShelfGrid, SearchField · chrome: Masthead, ProgressBar, NavDots, PhoneFrame, BottomNav, TOCList, ReaderToolbar). Each has a `.jsx`, a `.d.ts` props contract, and a `.prompt.md` usage note.
- `ui_kits/reader/` and `ui_kits/pitch/` — full-screen recreations of the product reading view and the pitch landing.
- `tokens/themes.css` — reader-only reading themes: default warm paper, `[data-rt-theme="sepia"]` 纸黄, `[data-rt-theme="night"]` 夜间. Set the attribute on the reader's root only; letter/landing surfaces always stay on paper.
- `templates/reader-app/` — the 阅读 App template: 书架 → 详情 → 阅读页 shell (search, shelf list/grid, brief, annotated reading view, Aa sheet, 目录 drawer, themes).

## How to work
- **Visual artifacts** (slides, mocks, throwaway prototypes): copy the assets/tokens you need and produce static HTML the user can open. Link `styles.css`, reuse the components, and stay inside the brand (warm paper, ink, one sage-green accent, two-voice type, huge whitespace).
- **Production code:** read the rules here and the component `.prompt.md` files to design as an expert in the brand.

## Non-negotiables (the brand dies without these)
- Warm paper `#FAFAF6`, never pure white; warm ink `#0A0A09`, never pure black; **green `#2F6A52` is a highlighter, never a fill**.
- Two type voices: **serif** (modern Ming) for narration/headings/reading, **sans** (geometric) for product UI, **mono** all-caps for tiny labels.
- Second-person, metaphor-rich, quiet copy — like a private letter. No emoji (one `✦` for the AI), no SaaS hype, no feature dumps.
- Signature elements: pale-green left-border annotation cards; dashed-rule kickers; asymmetric `0 4px 4px 0` radius; slow soft ease-out motion; `prefers-reduced-motion` respected.
- Avoid: pure black/white, retro 楷, multicolour gradients, stacked card shadows, generic icons.

If the user invokes this skill with no further guidance, ask what they want to build, ask a few focused questions, then act as an expert ReadTailor designer who outputs HTML artifacts *or* production code as needed.

## Note
The two display webfonts (上元明朝, 未来荧黑) are CDN-hosted (subset-on-demand); there are no local binaries. Offline they fall back to Noto Serif/Sans SC. If you have licensed files, add local `@font-face` rules to `tokens/fonts.css`.
