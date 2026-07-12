**SearchField** — the library search: a hairline **underline** (never a boxed input), mono `SEARCH` label on the left, underline + label turn green on focus. No magnifier icon.

```jsx
<SearchField value={q} onChange={e => setQ(e.target.value)} onSubmit={run} />
```

Controlled input; `onSubmit` fires on Enter. Keep it narrow (≤420px) and let whitespace breathe around it.
