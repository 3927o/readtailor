**TextField** — boxed form input: hairline border, asymmetric `0 4px 4px 0` radius, green focus border, mono uppercase label. `error` switches to brick-red (the system's only red).

```jsx
<TextField label="昵称" value={v} onChange={e => setV(e.target.value)} placeholder="怎么称呼你？" />
<TextField multiline rows={4} label="想问的" error="这一栏不能为空" />
```

For search use `SearchField` (underline style) instead.
