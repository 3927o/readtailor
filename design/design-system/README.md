# 裁读 ReadTailor · Design System

> **"一封安静的信" — a quiet letter.** Restrained, literary, editorial. Warm paper, ink black, one sage-green accent, and a two-voice type system. Not flashy SaaS, not Chinese-retro 古风 — the feel of a *contemporary hardback book + an independent magazine's inside pages*.

ReadTailor (裁读, "tailor-read") is an **AI reading companion**: it doesn't summarise a book *for* you, it walks *with* you so you actually finish it. It learns who you are, then tailors a book — a pre-reading brief, paved-in annotations (lead-ins, glosses, fill-ins, margin notes), and an in-line AI you can ask anything — so a hard book becomes finishable.

## Project usage

- During the 0-to-1 implementation, use `../prototypes/readtailor-mvp.dc.html` as the primary reference for page composition, end-to-end flow, responsive layout, and interaction rhythm. Product behavior and data contracts still come from the PRD, contracts, and architecture documents.
- After the 0-to-1 baseline is complete, use this design system as the primary reference for new features: reuse its tokens, components, and general rules while staying consistent with the implemented product.
- The prototype runtime, mock data, timers, and local state are demonstration mechanisms, not production contracts.

---

## Sources and references

- **Chinese design guide:** [`references/design-guide.zh-CN.md`](references/design-guide.zh-CN.md).
- **Current machine-readable source:** `styles.css`, `tokens/`, `_ds_manifest.json`, and the component contracts under `components/`.
- **Historical product references:** `public/zara.html` supplied the original full-text reading-companion patterns; `public/bp.html` supplied the editorial pitch patterns. Those source files are not part of this repository. Their reusable results live in `ui_kits/reader/` and `ui_kits/pitch/`.

---

## CONTENT FUNDAMENTALS — how ReadTailor writes

The copy is the brand as much as the visuals. It reads like a **private letter**, not product marketing.

- **Voice:** second person, low, intimate. "你好，我的朋友。" "你愿意，我们就开始。" The product speaks *to one reader*, warmly and a little quietly.
- **Metaphor over feature lists.** A hard book is "一座没有路标的森林"; the product is "向导" not "替你走路的人." Reassurance over hype: "先给你吃颗定心丸……卡住不代表你不行。"
- **Short sentences, lots of breath.** Line breaks control rhythm. Text never fills the width.
- **Bilingual editorial chrome.** Chinese carries meaning; small tracked English/mono acts as magazine decoration — `· ReadTailor`, `ISSUE`, `BP · 2026`, kicker pairs like `问题 · The Problem`.
- **Letter-style sign-offs:** `—— ReadTailor · 裁读 / 2026`.
- **Casing & punctuation:** mono labels are ALL-CAPS + wide-tracked. In prose, the print vocabulary is `·` interpuncts, `——` em-dashes, `⌜ ⌟` quote-corners — not UI icons.
- **No emoji** (one exception: a single `✦` sparkle marks the AI affordance). No exclamatory sales talk, no "🚀 supercharge your reading."
- **Forbidden tone:** SaaS marketing, imperative hype, feature dumps, anything loud.

> Paste-ready brief: *Editorial / literary-magazine interior, a quiet "letter." Warm paper #FAFAF6, warm near-black ink #0A0A09, one sage-green accent #2F6A52. Two type voices: modern Ming serif for narration, geometric sans for product UI, mono all-caps for tiny labels. Huge whitespace, one sentence per screen, narrow centred columns. Signature elements: pale-green left-border annotation cards, dashed-rule kickers, char-by-char text reveals. Slow, soft ease-out motion. Second-person, metaphor-rich, never salesy. Avoid: pure black/white, retro 楷, multicolour gradients, emoji, stacked SaaS shadows.*

---

## VISUAL FOUNDATIONS

- **Color.** ~90% of any screen is warm paper + ink/grey. Green is a *highlighter*, never a fill area — it lights emphasis words (`<em>` in italic deep-green), selected chips, the CTA, a progress dot, an annotation card's left edge. Paper is `#FAFAF6` (never pure white); ink is `#0A0A09` (never pure black). The lone non-green color is brick-red `#b4452f`, **form errors only**.
- **Type — the two-voice system.** (1) **Serif** 上元明朝 (LanternMingA) / Noto Serif SC = the *letter*: narration, headings, reading body. (2) **Sans** 未来荧黑 (Glow Sans SC) / Noto Sans SC = the *product UI*: anything inside the phone shell / controls. (3) **Mono** JetBrains Mono = *chrome*: kickers, issue lines, always uppercase + 0.12–0.22em tracking. The phone shell re-points the serif/mono tokens to the sans, so "this is a product, that is a letter" is felt automatically.
- **Backgrounds.** Flat warm paper. No photography, no full-bleed imagery, no gradients-as-decoration, no textures. The only "gradient" is a 96px bottom fade dissolving leaving text into the paper, and a 2px green progress sliver.
- **Layout.** Generous: stage padding ~110px/64px; content measures stay narrow (38ch narration, 720px reading, 1000px demo). One-sentence-per-screen discrete paging on the landing; centred narrow column. Fixed elements: top masthead (frosted), top progress bar, bottom dot-nav.
- **Motion.** Slow, soft, with lift — almost everything on one curve `cubic-bezier(.2,.7,.2,1)`. Signature: **char-by-char reveal** (each glyph opacity 0→1 + translateY 0.24em→0 + blur 2→0, ~55ms stagger, longer pause at punctuation). Scenes fade + rise on enter. Controls inside the product fade *plainly* (no rise/blur) — controls shouldn't "perform" like a sentence. Always honor `prefers-reduced-motion`.
- **Hover / press.** Buttons: green → deep-green on hover. Outline chips: ink-3 border + darker text on hover; selected = soft-green wash + green border. Marks: soft-green wash on hover/active. No scale-bounce; transitions ~160ms.
- **Borders & rules.** Hairlines `rgba(10,10,9,.12)` and fainter `.06`. The **signature border** is a 2px solid green *left edge* on annotation cards.
- **Corner radii.** The signature is **asymmetric**: `0 4px 4px 0` (square left where the border lives, rounded right). Soft cards 8–14px; pills 999px; phone 38px / screen 28px.
- **Cards.** Annotation cards = pale-green wash + green left edge, *no shadow*. The brief/white cards get a single soft low shadow (`0 6px 24px -16px rgba(20,40,30,.25)`), never stacked SaaS shadows. Popovers get a soft two-layer shadow + a 2px colored top edge keyed to the note type.
- **Transparency / blur.** Used only for the masthead (`saturate(150%) blur(10px)`) and the bottom dot-nav pill — the "frosted cover" feel.
- **Imagery / figures.** No photos. Concept diagrams are **sage hairline line-art** (funnel, rings, matrix, data-flywheel) — single weight, green + grey strokes, serif labels. This restrained line-figure language *is* a brand asset; reuse it, don't replace it with clip-art or filled illustration.

---

## ICONOGRAPHY

ReadTailor is **almost icon-free** — typography and rules do the work.

- **No icon font, no icon library, no PNG icons.** The codebase ships none.
- The few glyphs that appear are **inline single-weight SVG line figures** drawn in the brand's hairline style (the P3 step icons, concept diagrams). They use `stroke: var(--rt-green)` / `var(--rt-rule)`, ~1.5–2px, round caps. Treat these as part of the visual system, not as a swappable icon set. They're copied into the Pitch UI kit.
- **Unicode-as-icon** carries most "iconography": `≡` (menu), `Aa` (type settings), `‹ ›` (nav), `···` (overflow), `↑` (send), `→` `↳` (flow), `×` (close), `·` `——` `⌜ ⌟` (print punctuation), and one `✦` **sparkle** = the AI affordance (the only decorative glyph allowed).
- **No emoji.** (`✦` is a typographic star, used sparingly for the AI.)
- If you genuinely need more icons, use a **thin line set** (e.g. Lucide / Phosphor light) at 1.5px to match — but prefer a word or a rule first. *No icon CDN is currently wired; flag any addition.*

There is **no image logo** — the brand mark is typographic: `裁读` (serif, tracked) over `ReadTailor` (mono, wide-tracked, flanked by short rules). See `guidelines/brand-wordmark.card.html`.

---

## INDEX — what's in this system

**Global entry**
- `styles.css` — the one file consumers link (an `@import` manifest only).
- `tokens/` — `fonts.css` (webfonts), `colors.css`, `themes.css` (reading themes: default paper, `[data-rt-theme="sepia"]` 纸黄, `[data-rt-theme="night"]` 夜间 — reader view only), `typography.css`, `spacing.css`, `motion.css`.

**Foundations** (`guidelines/*.card.html`) — specimen cards in the Design System tab: color (surfaces / ink / green / rules), type (display / reading / UI / mono), spacing (scale / radius / measures / shadow+easing), brand (wordmark / annotation card / mark legend).

**Components** (`components/<group>/`) — React primitives, namespace `window.ReadTailorDesignSystem_…`:
- `core/` — **Button** (green pill, 3 variants), **Chip** (pill toggle / tag), **Kicker** (mono section label), **Toggle** (settings switch), **Slider** (字号/行距 range), **Segmented** (2–4 option control), **TextField** (boxed input + error), **Toast** (frosted passing note), **EmptyState** (⌜ ⌟ quiet empty view).
- `reading/` — **AnnotationCard** (lead / margin / fill-in), **Mark** (inline gloss anchor), **BriefCard** (read-before briefing).
- `library/` — **BookCover** (typographic jacket, green spine), **BookListItem** (shelf row + progress sliver), **ShelfGrid** (cover grid), **SearchField** (underline search).
- `chrome/` — **Masthead**, **ProgressBar**, **NavDots**, **PhoneFrame**, **BottomNav** (frosted word-label tabs), **TOCList** (目录 drawer list), **ReaderToolbar** (frosted reader top bar).

**UI kits** (`ui_kits/<product>/`)
- `reader/` — the product reading view (brief, paved text, marks, popovers, Aa settings, AI panel). *The product.*
- `pitch/` — the editorial one-sentence-per-screen pitch landing.

**Templates** (`templates/<slug>/`)
- `reader-app/` — 阅读 App: the full app shell (书架 search + list/grid → 书籍详情 brief → 阅读页 with annotations, Aa settings sheet, 目录 drawer, paper/sepia/night themes).

**Skill** — `SKILL.md` (Agent-Skill compatible).

---

## CAVEATS / SUBSTITUTIONS

- **Display webfonts are CDN-only.** 上元明朝 (LanternMingA) and 未来荧黑 (Glow Sans SC) load from ZeoSeven's subset-on-demand CDN; there are no local binaries to vendor. Offline, the stacks fall back to **Noto Serif SC / Noto Sans SC** (also CDN, Google Fonts). If you have the licensed font files, drop them in `assets/fonts/` and add local `@font-face` rules to `tokens/fonts.css`.
