/** Renders the progressively published reading brief without offering a feedback action. */

import type { BriefDraftView, BriefTranscriptEntry } from '../../transcript/types';
import { StreamingCursor } from '../primitives/StreamingCursor';

const BRIEF_SECTIONS = [
  ['bookIdentity', '这是一本什么书'],
  ['arc', '全书怎么走'],
  ['assumedKnowledge', '假设你已经知道'],
  ['readingAdvice', '建议你的读法'],
] as const satisfies ReadonlyArray<readonly [keyof BriefDraftView, string]>;

export function BriefEntry({ entry }: { entry: BriefTranscriptEntry }) {
  const active = entry.renderState === 'streaming' || entry.renderState === 'working';
  const populatedIndices = BRIEF_SECTIONS
    .map(([key], index) => entry.brief[key] ? index : -1)
    .filter((index) => index >= 0);
  const inferredActiveIndex = populatedIndices.at(-1) ?? 0;
  const activeIndex = entry.streamingField
    ? BRIEF_SECTIONS.findIndex(([key]) => key === entry.streamingField)
    : inferredActiveIndex;
  const visibleSections = active
    ? BRIEF_SECTIONS.slice(0, Math.max(activeIndex + 1, 1))
    : BRIEF_SECTIONS.filter(([key]) => entry.brief[key]);

  return (
    <article className="rss-brief-entry" data-state={entry.renderState}>
      <span className="rss-entry-kicker">读前简报</span>
      <h2>我先给你画一张小地图</h2>

      {visibleSections.map(([key, label], index) => (
        <section
          key={key}
          className="rss-brief-section"
          data-personalized={key === 'readingAdvice' || undefined}
          data-streaming={active && index === activeIndex || undefined}
        >
          <h3>{label}</h3>
          <p>
            {entry.brief[key] ?? (
              <span className="rss-entry-placeholder">正在整理…</span>
            )}
            <StreamingCursor
              active={entry.renderState === 'streaming' && index === activeIndex}
            />
          </p>
        </section>
      ))}

      {entry.renderState === 'working' ? (
        <p className="rss-entry-status" role="status">我在把这张地图和原文对齐…</p>
      ) : null}
      {entry.renderState === 'failed' ? (
        <p className="rss-entry-error" role="alert">
          {entry.error ?? '这份简报暂时没有整理完。'}
        </p>
      ) : null}
    </article>
  );
}
