**Segmented** — 2–4 option control (阅读主题, 网格/列表视图). Hairline pill track; selected segment = soft-green wash + deep-green text.

```jsx
<Segmented label="阅读主题" value={theme} onChange={setTheme}
           options={[{value:'paper',label:'纸白'},{value:'sepia',label:'纸黄'},{value:'night',label:'夜间'}]} />
```

For >4 options use `Chip`s instead.
