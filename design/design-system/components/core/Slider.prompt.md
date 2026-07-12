**Slider** — reader-settings range (字号 / 行距 / 批注密度): a 2px track, green filled side, small white thumb with a green hairline. Optional mono readout via `showValue` + `format`.

```jsx
<Slider label="字号" min={14} max={24} value={fontSize}
        onChange={setFontSize} showValue format={v => v + 'px'} />
```

`onChange` receives the number. Keep it inside the Aa settings sheet, ~240–320px wide.
