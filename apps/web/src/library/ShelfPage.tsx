import { useQuery } from '@tanstack/react-query';
import type { BookCatalogItem, SharedBookStatus } from '@readtailor/contracts';
import { Link } from 'react-router';
import { EmptyState } from '../components/core/EmptyState';
import { Kicker } from '../components/core/Kicker';
import { bookCoverUrl, getBookCatalog, getHealth } from './api';
import { LibraryChrome } from './LibraryChrome';

const statusCopy: Record<SharedBookStatus, { label: string; meta: string }> = {
  queued: { label: '排队中', meta: '已经收下，等待开始处理' },
  normalizing: { label: '规范化中', meta: '正在整理这个 EPUB 版本' },
  validating: { label: '校验中', meta: '正在执行结构与保真检查' },
  indexing: { label: '整理中', meta: '正在生成阅读节点' },
  analyzing: { label: '分析中', meta: '正在准备全书画像' },
  ready: { label: '已就绪', meta: '可以开始阅读' },
  failed: { label: '处理失败', meta: '这个版本暂时无法处理' },
};

export function ShelfPage() {
  const health = useQuery({ queryKey: ['api-health'], queryFn: getHealth, retry: 1 });
  const books = useQuery({
    queryKey: ['book-catalog'],
    queryFn: getBookCatalog,
    refetchInterval: (query) => query.state.data?.books.some((book) => !['ready', 'failed'].includes(book.status))
      ? 4000
      : false,
  });
  const connected = health.data?.status === 'ok';

  return (
    <LibraryChrome service={{ connected, pending: health.isPending }}>
      <main className="shelf">
        <div className="section-heading">
          <div>
            <Kicker>YOUR SHELF · 你的书架</Kicker>
            <h1>在读与想读</h1>
          </div>
          <Link className="button button-secondary" to="/books/import">＋ 上传 EPUB</Link>
        </div>

        {books.isError ? (
          <EmptyState
            title="书架暂时没有打开"
            action={<button className="button button-ghost" type="button" onClick={() => void books.refetch()}>重新连接</button>}
          >{books.error.message}</EmptyState>
        ) : books.isPending ? (
          <ShelfLoading />
        ) : books.data.books.length === 0 ? (
          <EmptyState
            title="书架还空着"
            action={<Link className="button button-secondary" to="/books/import">放入第一本书</Link>}
          >一本书先在这里整理好，才会被展开成安静、可读的页面。</EmptyState>
        ) : (
          <section className="book-list" aria-label="书架书籍">
            <div className="book-list-count">{books.data.books.length} BOOKS · 共 {books.data.books.length} 本</div>
            {books.data.books.map((book) => <BookRow key={book.id} book={book} />)}
          </section>
        )}

        <footer className="shelf-footer">—— 读完一本，胜过收藏一百本。</footer>
      </main>
    </LibraryChrome>
  );
}

function BookRow({ book }: { book: BookCatalogItem }) {
  const ready = book.status === 'ready';
  const target = ready ? `/books/${book.id}/read` : `/books/${book.id}/processing`;
  const status = statusCopy[book.status];
  const author = book.authors.join(' · ') || '作者未详';
  const cover = ready ? bookCoverUrl(book.id, book.coverPath) : undefined;
  return (
    <Link className="book-row" to={target} data-status={book.status}>
      <div className="book-cover" aria-hidden="true">
        {cover ? <img src={cover} alt="" /> : <><strong>{book.title}</strong><span>{author}</span></>}
      </div>
      <div className="book-row-copy">
        <h2>{book.title}</h2>
        <p>{author} · {status.meta}</p>
      </div>
      <span className="book-status">{status.label}</span>
      <span className="book-row-arrow" aria-hidden="true">›</span>
    </Link>
  );
}

function ShelfLoading() {
  return (
    <div className="shelf-loading" aria-label="正在读取书架">
      <span /><span /><span />
    </div>
  );
}
