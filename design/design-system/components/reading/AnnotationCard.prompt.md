**AnnotationCard** — ReadTailor's signature container: the AI's note laid alongside the text. Three kinds:

```jsx
<AnnotationCard kind="lead" title="下山入世：孤独的完成"
  bullets={['查拉图斯特拉隐居十年后决定下山。', '智慧积得太满，必须分出去。']} />

<AnnotationCard kind="margin" anchor="到山里去">
  不是字面的隐居，而是远离世俗、独自思考的象征。
</AnnotationCard>

<AnnotationCard kind="fillin" trigger="推理跳跃">
  换句话说：当你说"他是诚实的"，这个诚实本身要在每次选择中"去诚实地存在"才得以维持。
</AnnotationCard>
```

`lead` = green wash + solid green left edge (the always-open chapter lead-in) · `margin` = quiet hairline rule (脉络) · `fillin` = sunken grey, dotted edge (推理补全). Pass `trigger` to show why the note fired ("触发 · 术语陌生"). This is the brand's most recognisable element — don't restyle it with generic card shadows.
