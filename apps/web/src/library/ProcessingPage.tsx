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

type Stage = 'uploaded' | 'fingerprinted' | 'queued' | 'normalizing' | 'validating' | 'publishing';

// 只展示用户可理解的失败类型，不暴露内部报错；技术细节留在服务端日志。
const failureCopy: Record<NormalizationFailureType, string> = {
  timeout: '处理超时了，可以重试。',
  validation_failed: '这本书的结构没能通过校验，可能是排版特殊或包含无法可靠解析的内容。',
  external_error: '沙箱或模型服务出错了，可以重试。',
  internal_error: '处理时出现内部错误，可以重试。',
  stale_worker: '处理进程中断了，可以重试。',
};

function failureMessage(failureType: NormalizationFailureType | null): string {
  return failureType
    ? failureCopy[failureType]
    : '可能是加密、DRM，或文件结构无法可靠解包。';
}

const steps: ReadonlyArray<{ key: Stage; label: string; cn: string; detail: string }> = [
  { key: 'uploaded', label: 'UPLOADED', cn: '已上传', detail: '文件已经安全写入对象存储。' },
  { key: 'fingerprinted', label: 'FINGERPRINT', cn: '指纹校验', detail: 'SHA-256 已确认，并检查可复用的书籍包。' },
  { key: 'queued', label: 'QUEUED', cn: '排队中', detail: '清洗任务已经创建，等待 Worker 接手。' },
  { key: 'normalizing', label: 'NORMALIZING', cn: '规范化中', detail: 'Agent 正在检查 EPUB，并编写、执行这本书的 normalize.py。' },
  { key: 'validating', label: 'VALIDATING', cn: '硬校验', detail: 'Worker 独立执行结构、资源与保真检查。' },
  { key: 'publishing', label: 'PUBLISHING', cn: '整理并发布', detail: '生成阅读节点和书籍画像，再原子发布不可变书籍包。' },
];

const statusRank: Record<SharedBookStatus, number> = {
  queued: 2,
  normalizing: 3,
  validating: 4,
  indexing: 5,
  analyzing: 5,
  ready: 6,
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
          <EmptyState title="正在找到这本书">清洗记录正在从 Worker 汇合过来。</EmptyState>
        ) : query.isError ? (
          <EmptyState
            title="暂时读不到处理进度"
            action={<button className="button button-ghost" type="button" onClick={() => void query.refetch()}>重新连接</button>}
          >{query.error.message}</EmptyState>
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
  const fingerprint = book.epubSha256.slice(0, 12);
  const attempt = run?.latestAttempt;

  return (
    <>
      <Kicker>BOOK NORMALIZATION · 书籍规范化</Kicker>
      <h1>《{book.title}》</h1>
      <div className="book-fingerprint">SHA-256 · {fingerprint}…</div>

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
            <li key={step.key} data-state={state}>
              <div className="step-rail">
                <span className="step-dot" aria-hidden="true">{state === 'done' ? '✓' : state === 'failed' ? '×' : ''}</span>
                {index < steps.length - 1 ? <i aria-hidden="true" /> : null}
              </div>
              <div className="step-copy">
                <div>{String(index + 1).padStart(2, '0')} · {step.label} · {step.cn}</div>
                <p>{step.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>

      {attempt ? (
        <section className="attempt-summary" aria-label="当前规范化尝试">
          <div><span>ATTEMPT</span><strong>{attempt.attemptNo}</strong></div>
          <div><span>AGENT</span><strong>{attempt.turnCount} turns · {attempt.toolCallCount} tools</strong></div>
          <div><span>ERROR</span><strong data-error={(attempt.blockingErrorCount ?? 0) > 0}>{attempt.blockingErrorCount ?? '—'}</strong></div>
          <div><span>WARNING</span><strong>{attempt.warningCount ?? '—'}</strong></div>
        </section>
      ) : null}

      {!done && !failed ? (
        <p className="processing-note">进度只在站内展示。你可以先离开，处理完后这本书会留在书架。</p>
      ) : null}
      {done ? (
        <section className="processing-result" data-result="ready">
          <h2>规范化完成，硬校验已通过。</h2>
          <p>这份不可变书籍包已经发布。回到书架后，会从这本书自己的访谈阶段开始。</p>
          <div><Link className="button button-primary" to="/">回到书架，开始访谈</Link></div>
        </section>
      ) : null}
      {failed ? (
        <section className="processing-result" data-result="failed">
          <h2>这个版本暂时无法处理。</h2>
          <p>{failureMessage(book.failureType)}</p>
          {retry.isError ? <p className="processing-error">{retry.error.message}</p> : null}
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
  if (step === 'publishing' || step === 'analyzing' || step === 'indexing') return 5;
  if (step === 'validating') return 4;
  if (step === 'normalizing') return 3;
  if (step === 'queued') return 2;
  return Math.max(0, statusRank[status]);
}
