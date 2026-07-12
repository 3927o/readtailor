**Mark** — an inline, tappable annotation anchor inside the reading text. The underline style telegraphs the note type before you even tap.

```jsx
他在那里安享他的<Mark type="gloss" onActivate={open}>智慧和孤独</Mark>，
<Mark type="fillin">十年不倦</Mark>。
```

`gloss` = dotted (释义) · `fillin` = dashed (推理补全) · `margin` = wavy amber (脉络). Hover/active draws a soft-green wash. Keep marks sparse — only on phrases that genuinely need a note, never whole sentences of them in a row.
