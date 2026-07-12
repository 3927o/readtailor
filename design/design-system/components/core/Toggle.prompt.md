**Toggle** — settings switch. Off = hairline pill on `--rt-bg-2`; on = sage-green fill. 160ms, no bounce.

```jsx
<Toggle checked={night} onChange={setNight} label="夜间模式" />
```

`onChange` receives the next boolean. Pair it with a serif/sans settings row label; `label` is aria-only.
