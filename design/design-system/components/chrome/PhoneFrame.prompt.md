**PhoneFrame** — the charcoal device shell that holds the reading app in demos. Notch, home bar, soft layered shadow.

```jsx
<PhoneFrame width={280} height={560}>
  <div style={{ padding: 20, overflowY: 'auto', height: '100%' }}>
    {/* reading view — already in the UI-sans voice */}
  </div>
</PhoneFrame>
```

The interior automatically re-points `--rt-serif` / `--rt-mono` to the UI sans (`--rt-demo`), so the app chrome inside speaks Glow Sans — the "this is a product, that is a letter" split. Body `#1A1916`, 38px radius.
