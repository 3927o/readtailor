**Button** — ReadTailor's primary action: a serif-labelled green pill. Use `primary` for the one real CTA on a view; green is the brand's only fill.

```jsx
<Button variant="primary" onClick={start}>你愿意，我们就开始</Button>
<Button variant="secondary">稍后再说</Button>
<Button variant="ghost" size="sm">跳过</Button>
```

Variants: `primary` (green fill, white label) · `secondary` (green outline + soft wash on hover) · `ghost` (hairline border, ink label). Sizes: `sm` · `md` · `lg`. Label font is the serif "letter" voice, not the UI sans — keep button copy short and human ("你愿意，我们就开始"), never SHOUTY marketing.
