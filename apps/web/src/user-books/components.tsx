import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { EmptyState } from '../components/core/EmptyState';
import { Kicker } from '../components/core/Kicker';
import { bookCoverUrl } from '../library/api';
import { LibraryChrome } from '../library/LibraryChrome';
import type {
  TailoredAnnotation,
  UserBookSharedBook,
} from './api';

export function WorkflowPage({ book, kicker, title, children }: {
  book: UserBookSharedBook;
  kicker: string;
  title: string;
  children: ReactNode;
}) {
  const cover = bookCoverUrl(book.id, book.coverPath);
  return (
    <LibraryChrome>
      <main className="workflow-page">
        <header className="workflow-book-header">
          <div className="workflow-book-cover" aria-hidden="true">
            {cover ? <img src={cover} alt="" /> : <><strong>{book.title}</strong><span>{book.authors.join(' · ')}</span></>}
          </div>
          <div>
            <Kicker>{kicker}</Kicker>
            <h1>{title}</h1>
            <p>{book.title}{book.authors.length ? ` · ${book.authors.join(' · ')}` : ''}</p>
          </div>
        </header>
        {children}
      </main>
    </LibraryChrome>
  );
}

export function WorkflowMessage({ title, children, action }: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="workflow-message">
      <div className="workflow-typing" aria-hidden="true"><span /><span /><span /></div>
      <h2>{title}</h2>
      <div>{children}</div>
      {action ? <div className="workflow-message-action">{action}</div> : null}
    </section>
  );
}

export function BriefCard({ briefing }: { briefing: string }) {
  return (
    <section className="brief-card">
      <Kicker>BEFORE YOU READ · 读前简报</Kicker>
      <h2>读之前，我想先和你说几句</h2>
      <div className="brief-section" data-personalized>
        <AssistanceContent content={briefing} />
      </div>
    </section>
  );
}

export function AssistanceContent({ content }: { content: string }) {
  const blocks = content.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  return (
    <div className="assistance-content">
      {(blocks.length ? blocks : [content]).map((block, index) => {
        const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
        const list = lines.length > 1 && lines.every((line) => /^[-*]\s+/.test(line));
        if (list) {
          return <ul key={index}>{lines.map((line) => <li key={line}>{line.replace(/^[-*]\s+/, '')}</li>)}</ul>;
        }
        return <p key={index}>{block.replace(/^#{1,6}\s+/, '')}</p>;
      })}
    </div>
  );
}

export function AnnotationList({ annotations }: { annotations: TailoredAnnotation[] }) {
  if (!annotations.length) return null;
  return (
    <section className="tailored-annotations" aria-label="裁读注">
      <Kicker>TAILORED NOTES · 裁读注</Kicker>
      {annotations.map((annotation, index) => (
        <article className="tailored-annotation" id={`tailored-annotation-${annotation.id}`} key={annotation.id}>
          <div className="tailored-anchor">
            注 {index + 1} · BLOCK {annotation.range.start.blockIndex}
            {' · '}{annotation.range.start.offset}–{annotation.range.end.blockIndex === annotation.range.start.blockIndex
              ? annotation.range.end.offset
              : `${annotation.range.end.blockIndex}:${annotation.range.end.offset}`}
          </div>
          <AssistanceContent content={annotation.content} />
        </article>
      ))}
    </section>
  );
}

export function AdjustmentForm({ value, onChange, onSubmit, pending, label, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  label: string;
  placeholder: string;
}) {
  return (
    <div className="adjustment-form">
      <label htmlFor="workflow-feedback">{label}</label>
      <textarea
        id="workflow-feedback"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        disabled={pending}
      />
      <button className="button button-ghost" type="button" disabled={!value.trim() || pending} onClick={onSubmit}>
        {pending ? '正在重新起草…' : '提交反馈，重新起草'}
      </button>
    </div>
  );
}

export function BackToShelf() {
  return <Link className="text-button" to="/">返回书架</Link>;
}

export function WorkflowFallback({ title, detail, retry }: {
  title: string;
  detail: string;
  retry?: () => void;
}) {
  return (
    <LibraryChrome>
      <main className="workflow-page">
        <EmptyState
          title={title}
          action={retry ? <button className="button button-ghost" type="button" onClick={retry}>重新连接</button> : undefined}
        >{detail}</EmptyState>
      </main>
    </LibraryChrome>
  );
}
