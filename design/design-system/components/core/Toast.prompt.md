**Toast** — passing note ("已加入书架"): frosted pill fixed bottom-centre, green dot + serif text. `accent` swaps the dot for the ✦ sparkle — AI messages only.

```jsx
<Toast visible={saved}>批注已保存</Toast>
<Toast accent visible={aiDone}>已为你整理好这一章</Toast>
```

Keep it mounted and toggle `visible`; auto-dismiss with your own timeout (~2.4s).
