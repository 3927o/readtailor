# Reader — ReadTailor 全本陪读 UI kit

A high-fidelity recreation of ReadTailor's core product: the AI reading-companion view. It was derived from the historical `public/zara.html` source, which is not included in this repository.

## What it shows
The reading view for a single book, end to end:
- **Masthead** — book title, author, and the reader-profile chips (为谁读 / 目标 / 替你扫 / 力度).
- **读前简报 (BriefCard)** — the collapsible pre-reading briefing: what the book is, the core terms glossary, and a green-washed *personalised* reading-prep note. Toggle it open/closed.
- **Paved text** — the original text, unaltered, with the AI's three annotation voices:
  - **章节导读 (lead)** — always-open green-edge card before each unit.
  - **inline Marks** — dotted 释义 / dashed 推理补全 / wavy 脉络; click one to open its popover.
  - margin & fill-in notes inline.
- **Aa settings** — font size / line-height / page width, live.
- **AI companion panel** — the "✦ 就这段问问 AI" slide-in chat (canned, brand-voiced reply; quick-question chips).

## Composition
Built from the design-system primitives — `Mark`, `AnnotationCard`, `BriefCard`, `ProgressBar` from `window.ReadTailorDesignSystem_39423e`. Reader-specific shell, popover, settings and AI panel live here.

## Files
- `index.html` — entry; interactive reading view.
- `reader-data.js` — brief + annotated reading content (plain global, no JSX).
- `ReaderApp.jsx` — reading-view shell (masthead, brief, text, marks, popover, tools).
- `AiPanel.jsx` — AI companion chat + Aa settings popover.

## Faithfulness notes
The AI replies are **faked** — no live LLM. The TOC drawer (目录) is present as a button but not wired (the source has a full table of contents; omitted here to keep the kit focused on the reading experience). Selection-to-ask is simplified to a single floating button.
