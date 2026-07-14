import { useQuery } from '@tanstack/react-query';
import type { SharedBookStatus } from '@readtailor/contracts';
import { Link } from 'react-router';
import { EmptyState } from '../components/core/EmptyState';
import { Kicker } from '../components/core/Kicker';
import { getUserBooks } from '../user-books/api';
import type { UserBookSummary, WorkflowStatus } from '../user-books/api';
import { routeForUserBook } from '../user-books/routes';
import { bookCoverUrl, getHealth } from './api';
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

const workflowCopy: Record<WorkflowStatus, { label: string; meta: string }> = {
  on_shelf: { label: '开始裁读', meta: '先聊几句，准备这本书的读法' },
  interviewing: { label: '继续访谈', meta: '上次的回答已经保存' },
  strategy_review: { label: '确认处理方式', meta: '读前简报和草稿等你确认' },
  trial_generating: { label: '正在生成试读', meta: '三个片段会完整生成后一起出现' },
  trial_generation_failed: { label: '试读生成失败', meta: '可以重试整轮生成' },
  trial_review: { label: '查看试读', meta: '三个片段等你逐个确认' },
  active_reading: { label: '继续阅读', meta: '回到上次读到的位置' },
};

export function ShelfPage() {
  const health = useQuery({ queryKey: ['api-health'], queryFn: getHealth, retry: 1 });
  const books = useQuery({
    queryKey: ['user-books'],
    queryFn: getUserBooks,
    refetchInterval: (query) => query.state.data?.userBooks.some((book) => (
      !['ready', 'failed'].includes(book.sharedBook.status)
      || ['trial_generating', 'interviewing'].includes(book.workflowStatus)
    ))
      ? 3500
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
        ) : books.data.userBooks.length === 0 ? (
          <EmptyState
            title="书架还空着"
            action={<Link className="button button-secondary" to="/books/import">放入第一本书</Link>}
          >一本书先在这里整理好，才会被展开成安静、可读的页面。</EmptyState>
        ) : (
          <section className="book-list" aria-label="书架书籍">
            <div className="book-list-count">{books.data.userBooks.length} BOOKS · 共 {books.data.userBooks.length} 本</div>
            {books.data.userBooks.map((book) => <BookRow key={book.id} book={book} />)}
          </section>
        )}

        <footer className="shelf-footer">—— 读完一本，胜过收藏一百本。</footer>
      </main>
    </LibraryChrome>
  );
}

function BookRow({ book }: { book: UserBookSummary }) {
  const shared = book.sharedBook;
  const ready = shared.status === 'ready';
  const target = routeForUserBook(book);
  const status = ready ? workflowCopy[book.workflowStatus] : statusCopy[shared.status];
  const author = shared.authors.join(' · ') || '作者未详';
  const cover = bookCoverUrl(shared.id, shared.coverPath);
  const readingMeta = book.workflowStatus === 'active_reading' && book.readingProgress
    ? readingSummary(book.readingProgress.percent, book.readingProgress.estimatedRemainingSeconds)
    : status.meta;
  return (
    <Link className="book-row" to={target} data-status={ready ? book.workflowStatus : shared.status}>
      <div className="book-cover" aria-hidden="true">
        {cover ? <img src={cover} alt="" /> : <><strong>{shared.title}</strong><span>{author}</span></>}
      </div>
      <div className="book-row-copy">
        <h2>{shared.title}</h2>
        <p>{author} · {readingMeta}</p>
        {book.workflowStatus === 'active_reading' && book.readingProgress ? (
          <div className="book-reading-progress" aria-label={`阅读进度 ${Math.round(book.readingProgress.percent)}%`}>
            <i><span style={{ width: `${Math.max(0, Math.min(100, book.readingProgress.percent))}%` }} /></i>
            <span>{Math.round(book.readingProgress.percent)}%</span>
          </div>
        ) : null}
      </div>
      <span className="book-status">{status.label}</span>
      <span className="book-row-arrow" aria-hidden="true">›</span>
    </Link>
  );
}

function readingSummary(percent: number, remainingSeconds: number | null): string {
  if (remainingSeconds === null) return `全书 ${Math.round(percent)}%`;
  const minutes = Math.max(1, Math.round(remainingSeconds / 60));
  if (minutes < 60) return `全书 ${Math.round(percent)}% · 约剩 ${minutes} 分钟`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `全书 ${Math.round(percent)}% · 约剩 ${hours} 小时`;
}

function ShelfLoading() {
  return (
    <div className="shelf-loading" aria-label="正在读取书架">
      <span /><span /><span />
    </div>
  );
}
