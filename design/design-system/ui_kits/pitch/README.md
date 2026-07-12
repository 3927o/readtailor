# Pitch — ReadTailor 一封信式 BP UI kit

A recreation of ReadTailor's investor/landing deck: the editorial, **one-sentence-per-screen** scroll experience. It was derived from the historical `public/bp.html` source, which is not included in this repository.

## The format
Discrete vertical paging (scroll-snap): each viewport is one quiet "line of the letter." A fixed masthead up top, a 2px green progress sliver, and a minimal dot navigator at the bottom (the closing vision page is a diamond). Content reveals on enter — fade + rise — and never fills the screen.

## Scenes shown
- **P1 · 定义** — the wordmark, the one-line definition, a signoff.
- **P2 · 问题** — the drop-off funnel figure beside a "falling list" of the problem.
- **P3 · 解法** — the three annotation-card steps (了解你 → 定制 → 陪你读完).
- **P4 · Why Now** — green-edge blocks.
- **Coda · 愿景** — full-screen vision line.

(The full source has 12 scenes incl. an interactive product demo, market rings, a competitor matrix, team and ask. This kit keeps the representative scene *types* — title, problem+figure, step row, blocks, coda — so the patterns are reusable without reproducing every slide.)

## Build approach
Vanilla HTML + the design-system tokens (`styles.css`), exactly like the real `bp.html` — this editorial page is layout-driven, not component-driven, so it doesn't mount React primitives. The kicker, masthead, dot-nav and reveal patterns mirror the `Kicker` / `Masthead` / `NavDots` / `ProgressBar` components. The line figures (funnel, step icons) are the brand's established SVG visual language, copied from source.

## Files
- `index.html` — the full scroll-snap landing.
