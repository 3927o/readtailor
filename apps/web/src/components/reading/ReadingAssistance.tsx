/** Renders shared AI reading assistance and structured pre-reading briefs. */

import { createElement, Fragment, type ReactNode } from 'react';
import type { Briefing } from '@readtailor/contracts';
import { Kicker } from '../core/Kicker';
import { parseMarkdown, type InlineToken, type MarkdownBlock } from './markdown';

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
  const sections = BRIEFING_SECTIONS
    .map((section) => ({ ...section, text: briefing[section.key]?.trim() ?? '' }))
    .filter((section) => pending || section.text.length > 0);
  if (sections.length === 0) return null;
  return (
    <section className="brief-card">
      <Kicker>BEFORE YOU READ · 读前简报</Kicker>
      <h2>读之前，我想先和你说几句</h2>
      {sections.map((section) => (
        <div
          className="brief-section"
          key={section.key}
          data-personalized={section.prep ? 'true' : undefined}
        >
          <h3>{section.label}</h3>
          <p>
            {section.text || <span className="progressive-placeholder">正在整理…</span>}
          </p>
        </div>
      ))}
    </section>
  );
}

function renderInline(tokens: InlineToken[]): ReactNode[] {
  return tokens.map((token, index) => {
    switch (token.type) {
      case 'strong':
        return <strong key={index}>{renderInline(token.children)}</strong>;
      case 'em':
        return <em key={index}>{renderInline(token.children)}</em>;
      case 'code':
        return <code key={index}>{token.value}</code>;
      case 'text':
        return <Fragment key={index}>{token.value}</Fragment>;
    }
  });
}

function renderBlock(block: MarkdownBlock, index: number, trailing?: ReactNode): ReactNode {
  switch (block.type) {
    case 'heading':
      return createElement(
        `h${Math.min(6, block.level + 2)}`,
        { key: index },
        renderInline(block.content),
        trailing,
      );
    case 'list': {
      const items = block.items.map((item, itemIndex) => (
        <li key={itemIndex}>
          {renderInline(item)}
          {itemIndex === block.items.length - 1 ? trailing : null}
        </li>
      ));
      return block.ordered ? <ol key={index}>{items}</ol> : <ul key={index}>{items}</ul>;
    }
    case 'paragraph':
      return (
        <p key={index}>
          {renderInline(block.content)}
          {trailing}
        </p>
      );
  }
}

export function AssistanceContent({
  content,
  trailing,
}: {
  content: string;
  trailing?: ReactNode;
}) {
  const blocks = parseMarkdown(content);
  return (
    <div className="assistance-content">
      {blocks.length > 0
        ? blocks.map((block, index) => renderBlock(
            block,
            index,
            index === blocks.length - 1 ? trailing : undefined,
          ))
        : trailing}
    </div>
  );
}
