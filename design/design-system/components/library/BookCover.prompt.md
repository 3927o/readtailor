**BookCover** — a typographic hardback jacket: white card, hairline frame, 2px green left spine, asymmetric `0 4px 4px 0` radius. Serif title + mono author. No imagery by default — pass `src` only when a real cover exists.

```jsx
<BookCover title="查拉图斯特拉如是说" author="Nietzsche" />
<BookCover size="lg" title="存在与时间" author="Heidegger" />
<BookCover src="covers/zara.jpg" title="查拉图斯特拉如是说" />
```

Sizes: `sm` 72px (list thumbs) · `md` 108px (shelf grid) · `lg` 148px (detail page). Never hand-draw cover art; the type IS the cover.
