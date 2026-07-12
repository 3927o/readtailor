**Chip** — a pill toggle (book picker, "卡在哪 / 想拿到" questions) or a static profile tag. Selected = soft-green wash + green border; resting = quiet hairline.

```jsx
<Chip selected onClick={pick}>真正读懂</Chip>
<Chip serif>《罪与罚》</Chip>          {/* book titles use the serif voice */}
<Chip as="span">力度 · 适中偏密</Chip>  {/* static tag, not togglable */}
```

Defaults to the UI sans voice (`--rt-demo`); pass `serif` for book titles. Use `as="span"` for non-interactive tags (e.g. the brief's reader-profile chips).
