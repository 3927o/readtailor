**BriefCard** — the "读前简报" that frames a book before the reader opens it. A white card with a kicker, title, stacked label+body sections, an optional glossary, and one green-washed personalised `prep` section.

```jsx
<BriefCard
  title="读之前，你需要知道的"
  sections={[
    { label: '这是一本什么书', text: '《查拉图斯特拉如是说》以一位隐者下山布道开场……' },
    { label: '给你的读法准备（针对你）', prep: true, text: '先给你吃颗定心丸：这本书没人能一遍读通……' },
  ]}
  terms={[
    { term: '上帝死了', gloss: '不是无神论口号，而是一个文化诊断……' },
    { term: '超人', gloss: 'Übermensch。重点在"超越"这个动作。' },
  ]}
/>
```

Body copy is warm and second-person ("给你吃颗定心丸"), never a dry summary. The `prep` section is where the product speaks directly to *this* reader's stated goal and obstacles.
