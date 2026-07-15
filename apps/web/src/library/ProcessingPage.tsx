import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BookNormalizationStatus,
  NormalizationFailureType,
  SharedBookStatus,
} from '@readtailor/contracts';
import { Link, useParams } from 'react-router';
import { EmptyState } from '../components/core/EmptyState';
import { Kicker } from '../components/core/Kicker';
import { getBookNormalizationStatus, retryBookNormalization } from './api';
import { LibraryChrome } from './LibraryChrome';

type Stage = 'received' | 'preparing' | 'checking' | 'finishing';

// 只展示用户可理解的失败类型，不暴露内部报错；技术细节留在服务端日志。
const failureCopy: Record<NormalizationFailureType, string> = {
  timeout: '这次准备花的时间比预期久，请重试。',
  validation_failed: '这个版本的内容或排版比较特殊，暂时无法完整呈现。你可以重试，或换一个版本上传。',
  external_error: '准备过程中暂时中断了，请重试。',
  internal_error: '准备过程中暂时中断了，请重试。',
  stale_worker: '准备过程中暂时中断了，请重试。',
};

function failureMessage(failureType: NormalizationFailureType | null): string {
  return failureType
    ? failureCopy[failureType]
    : '这个文件可能已损坏、加密，或采用了暂不支持的格式。你可以换一个版本上传。';
}

const steps: ReadonlyArray<{ key: Stage; label: string; detail: string }> = [
  { key: 'received', label: '已收到书籍', detail: '文件已上传，正在安排后续准备。' },
  { key: 'preparing', label: '正在准备内容', detail: '正在整理正文、图片和注释，让内容更适合在线阅读。' },
  { key: 'checking', label: '正在检查阅读体验', detail: '正在确认内容完整、顺序清晰，阅读时不会轻易被打断。' },
  { key: 'finishing', label: '即将完成', detail: '正在完成最后的准备，很快就可以开始阅读。' },
];

const statusRank: Record<SharedBookStatus, number> = {
  queued: 0,
  normalizing: 1,
  validating: 2,
  indexing: 3,
  analyzing: 3,
  ready: 4,
  failed: -1,
};

export function ProcessingPage() {
  const { bookId = '' } = useParams();
  const query = useQuery({
    queryKey: ['book-normalization', bookId],
    queryFn: () => getBookNormalizationStatus(bookId),
    enabled: Boolean(bookId),
    refetchInterval: (current) => {
      const status = current.state.data?.book.status;
      return status && ['ready', 'failed'].includes(status) ? false : 2500;
    },
  });

  return (
    <LibraryChrome>
      <main className="processing-page">
        {query.isPending ? (
          <EmptyState title="正在获取最新进度">请稍候，这本书的准备状态马上就会显示。</EmptyState>
        ) : query.isError ? (
          <EmptyState
            title="暂时无法获取进度"
            action={<button className="button button-ghost" type="button" onClick={() => void query.refetch()}>重新连接</button>}
          >请检查网络后重试。已经完成的进度不会丢失。</EmptyState>
        ) : (
          <ProcessingContent status={query.data} bookId={bookId} />
        )}
      </main>
    </LibraryChrome>
  );
}

function ProcessingContent({ status, bookId }: { status: BookNormalizationStatus; bookId: string }) {
  const { book, run } = status;
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => retryBookNormalization(bookId),
    onSuccess: () => {
      // 重新排队后恢复轮询。
      void queryClient.invalidateQueries({ queryKey: ['book-normalization', bookId] });
    },
  });
  const done = book.status === 'ready';
  const failed = book.status === 'failed';
  const currentRank = done ? steps.length : rankFor(book.status, run?.step);

  return (
    <>
      <Kicker>GETTING READY · 准备阅读</Kicker>
      <h1>《{book.title}》</h1>

      <ol className="normalization-steps">
        {steps.map((step, index) => {
          const state = failed && index === Math.max(0, currentRank)
            ? 'failed'
            : index < currentRank
              ? 'done'
              : index === currentRank
                ? 'active'
                : 'pending';
          return (
            <li key={step.key} data-state={state} aria-current={state === 'active' ? 'step' : undefined}>
              <div className="step-rail">
                <span className="step-dot" aria-hidden="true">{state === 'done' ? '✓' : state === 'failed' ? '×' : ''}</span>
                {index < steps.length - 1 ? <i aria-hidden="true" /> : null}
              </div>
              <div className="step-copy">
                <div>{String(index + 1).padStart(2, '0')} · {step.label}</div>
                <p>{step.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>

      {!done && !failed ? (
        <p className="processing-note">你可以先离开。准备完成后，这本书会留在书架，回来就能继续。</p>
      ) : null}
      {done ? (
        <section className="processing-result" data-result="ready">
          <h2>这本书已经准备好了。</h2>
          <p>回到书架，先聊几句你的阅读目标，再开始阅读。</p>
          <div><Link className="button button-primary" to="/">回到书架，开始访谈</Link></div>
        </section>
      ) : null}
      {failed ? (
        <section className="processing-result" data-result="failed">
          <h2>这个版本暂时无法准备好。</h2>
          <p>{failureMessage(book.failureType)}</p>
          {retry.isError ? <p className="processing-error">暂时没能重新开始，请稍后再试。</p> : null}
          <div>
            <button
              className="button button-primary"
              type="button"
              onClick={() => retry.mutate()}
              disabled={retry.isPending}
            >
              {retry.isPending ? '正在重试…' : '重试'}
            </button>
            <Link className="button button-secondary" to="/books/import">重新上传</Link>
            <Link className="text-button" to="/">返回书架</Link>
          </div>
        </section>
      ) : null}
    </>
  );
}

function rankFor(status: SharedBookStatus, step?: string): number {
  if (step === 'publishing' || step === 'published' || step === 'analyzing' || step === 'indexing') return 3;
  if (step === 'validating') return 2;
  if (step === 'normalizing') return 1;
  if (step === 'queued') return 0;
  return Math.max(0, statusRank[status]);
}
