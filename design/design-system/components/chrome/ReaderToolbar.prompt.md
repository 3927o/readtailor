**ReaderToolbar** — the reader's frosted top bar: ‹ back, serif title, unicode-glyph actions on the right (`≡` 目录 · `Aa` 设置 · `✦` AI — ✦ renders green automatically). All targets ≥44px.

```jsx
<ReaderToolbar title="查拉图斯特拉如是说" onBack={close} actions={[
  { glyph: '≡', label: '目录', onClick: openTOC },
  { glyph: 'Aa', label: '阅读设置', onClick: openAa },
  { glyph: '✦', label: '问 AI', onClick: openAI },
]} />
```

Auto-hide it while reading (fade on scroll/tap); compose `ProgressBar` above it for reading progress. No icon fonts — glyphs only.
