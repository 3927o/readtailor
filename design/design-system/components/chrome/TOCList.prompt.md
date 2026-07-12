**TOCList** — the 目录 drawer's chapter list: mono `01 02 …` numerals, serif titles, hairline separators. Current chapter = 2px green left edge + soft wash; finished chapters are muted with a mono `READ` tag.

```jsx
<TOCList current={cur} onSelect={setCur} chapters={[
  { id: 'pre', title: '查拉图斯特拉的前言', read: true },
  { id: 'c1', title: '三种变形' },
]} />
```

Put it inside a drawer/sheet ~320px wide; it scrolls on its own.
