import { createElement, Fragment } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Briefing } from '@readtailor/contracts';
import { parseMarkdown, type InlineToken, type MarkdownBlock } from './markdown';
import { EmptyState } from '../components/core/EmptyState';
import { Kicker } from '../components/core/Kicker';
import { bookCoverUrl } from '../library/api';
import { LibraryChrome } from '../library/LibraryChrome';
import type { UserBookSharedBook } from './api/http';

export function WorkflowPage({ book, kicker, title, children, hideHeader }: {
  book: UserBookSharedBook;
  kicker: string;
  title: string;
  children: ReactNode;
  // The interview is an immersive full-screen conversation (prototype screen 05): it carries
  // its own eyebrow + sticky progress, so it opts out of the book header to avoid a redundant
  // second title.
  hideHeader?: boolean;
}) {
  const cover = bookCoverUrl(book.id, book.coverPath);
  return (
    <LibraryChrome>
      <main className="workflow-page" data-chromeless={hideHeader ? '' : undefined}>
        {hideHeader ? null : (
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
        )}
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

// The four labelled sections of the pre-reading briefing, in reading order. The last one
// (建议你的读法) is personalised advice, so it gets the green `prep` wash — mirroring the
// design-system BriefCard's flagged section.
const BRIEFING_SECTIONS: Array<{ key: keyof Briefing; label: string; prep?: boolean }> = [
  { key: 'bookIdentity', label: '这是一本什么书' },
  { key: 'arc', label: '全书怎么走' },
  { key: 'assumedKnowledge', label: '假设你已经知道' },
  { key: 'readingAdvice', label: '建议你的读法', prep: true },
];

export function BriefCard({
  briefing,
  pending = false,
}: {
  briefing: Partial<Briefing>;
  pending?: boolean;
}) {
  // Only render sections that actually carry text, so a briefing migrated from the legacy
  // free-text column (everything in bookIdentity, the rest empty) degrades to a single section
  // instead of showing three blank headings.
  const sections = BRIEFING_SECTIONS
    .map((section) => ({ ...section, text: briefing[section.key]?.trim() ?? '' }))
    .filter((section) => pending || section.text.length > 0);
  if (sections.length === 0) return null;
  return (
    <section className="brief-card">
      <Kicker>BEFORE YOU READ · 读前简报</Kicker>
      <h2>读之前，我想先和你说几句</h2>
      {sections.map((section) => (
        <div className="brief-section" key={section.key} data-personalized={section.prep ? 'true' : undefined}>
          <h3>{section.label}</h3>
          <p>{section.text || <span className="progressive-placeholder">正在整理…</span>}</p>
        </div>
      ))}
    </section>
  );
}

function renderInline(tokens: InlineToken[]): ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.type) {
      case 'strong': return <strong key={index}>{renderInline(token.children)}</strong>;
      case 'em': return <em key={index}>{renderInline(token.children)}</em>;
      case 'code': return <code key={index}>{token.value}</code>;
      case 'text': return <Fragment key={index}>{token.value}</Fragment>;
    }
  });
}

function renderBlock(block: MarkdownBlock, index: number): ReactNode {
  switch (block.type) {
    // `#` starts at h3 so body headings sit below the surrounding card's h2/h3 chrome.
    case 'heading': return createElement(`h${Math.min(6, block.level + 2)}`, { key: index }, renderInline(block.content));
    case 'list': {
      const items = block.items.map((item, i) => <li key={i}>{renderInline(item)}</li>);
      return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    case 'paragraph': return <p key={index}>{renderInline(block.content)}</p>;
  }
}

export function AssistanceContent({ content }: { content: string }) {
  return <div className="assistance-content">{parseMarkdown(content).map(renderBlock)}</div>;
}

export function AdjustmentForm({ value, onChange, onSubmit, pending, disabled = false, label, placeholder }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending: boolean;
  disabled?: boolean;
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
        disabled={pending || disabled}
      />
      <button className="button button-ghost" type="button" disabled={!value.trim() || pending || disabled} onClick={onSubmit}>
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
