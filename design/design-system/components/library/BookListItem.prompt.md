**BookListItem** — one bookshelf row: sm `BookCover` thumb, serif title, muted `author · meta` line, optional green progress sliver + mono `%`. Hairline separator below; soft-green wash on hover when `onClick` is given.

```jsx
<BookListItem title="查拉图斯特拉如是说" author="尼采" meta="读到 第三章"
              progress={42} onClick={open} />
<BookListItem title="存在与时间" author="海德格尔" meta="未开始" />
```

Rows are ≥44px tall (touch target). Stack them directly — the separator is built in.
