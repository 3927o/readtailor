**ShelfGrid** — the bookshelf cover grid: `auto-fill` columns, generous gaps, nothing else. Children are `BookCover`s, optionally wrapped with a serif caption below.

```jsx
<ShelfGrid>
  {books.map(b => <BookCover key={b.id} title={b.title} author={b.author} />)}
</ShelfGrid>
<ShelfGrid min={148} gap={32}>…lg covers…</ShelfGrid>
```

Match `min` to the cover size in use (72 / 108 / 148).
