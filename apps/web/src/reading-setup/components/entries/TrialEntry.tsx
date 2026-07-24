/** Renders the progressive trial excerpt, anchored annotations, feedback, and final confirmation. */

import { useEffect, useState } from 'react';
import { NotePopover, popoverPlacement } from '../../../reader/NotePopover';
import type { ActivePopover } from '../../../reader/NotePopover';
import { AssistanceContent } from '../../../user-books/components';
import type { ReadingSetupCommands } from '../../session/types';
import type { TrialTranscriptEntry } from '../../transcript/types';
import { InlineFeedback } from '../primitives/InlineFeedback';

export function TrialEntry({
  entry,
  commands,
  interactionsLocked = false,
}: {
  entry: TrialTranscriptEntry;
  commands: Pick<ReadingSetupCommands, 'sendFeedback' | 'confirmTrial'>;
  interactionsLocked?: boolean;
}) {
  const [activeAnnotationId, setActiveAnnotationId] = useState<string | null>(null);
  const [annotationPopover, setAnnotationPopover] = useState<ActivePopover | null>(null);
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const active = entry.renderState === 'streaming' || entry.renderState === 'working';
  const completed = entry.confirmation === 'completed';
  const superseded = entry.confirmation === 'superseded';
  const submitting = entry.confirmation === 'submitting' || confirmPending;
  const actionable = entry.renderState === 'ready'
    && entry.confirmation === 'available'
    && !interactionsLocked;
  const closeAnnotation = () => {
    setActiveAnnotationId(null);
    setAnnotationPopover(null);
  };

  useEffect(() => {
    if (!annotationPopover) return;
    const close = () => closeAnnotation();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [annotationPopover]);

  const openAnnotation = (annotationId: string, anchor: HTMLElement) => {
    const annotation = entry.annotations.find((item) => item.id === annotationId);
    if (!annotation) return;
    setActiveAnnotationId(annotationId);
    setAnnotationPopover({
      body: { kind: 'tailored', content: annotation.content },
      ...popoverPlacement(anchor.getBoundingClientRect()),
    });
  };

  const confirm = async () => {
    if (!actionable || confirmPending) return;
    setConfirmPending(true);
    setConfirmError(null);
    try {
      await commands.confirmTrial(entry.toolCallId);
    } catch {
      setConfirmError('这段试读还没有确认成功，再试一次就好。');
    } finally {
      setConfirmPending(false);
    }
  };

  return (
    <article className="rss-trial-entry" data-state={entry.renderState}>
      <header className="rss-trial-heading">
        <span className="rss-entry-kicker">试读</span>
        <h2>我们先一起读一小段</h2>
      </header>

      {entry.reason ? <p className="rss-trial-reason">{entry.reason}</p> : null}
      {entry.titlePath.length > 0 ? (
        <p className="rss-trial-location">{entry.titlePath.join(' › ')}</p>
      ) : null}

      {entry.guide ? (
        <section className="rss-reading-aid rss-reading-guide">
          <span>GUIDE · 导读</span>
          <AssistanceContent content={entry.guide} />
        </section>
      ) : active ? (
        <div className="rss-trial-placeholder" role="status">正在生成导读…</div>
      ) : null}

      {entry.paragraphs.length > 0 ? (
        <div className="rss-trial-original">
          {entry.paragraphs.map((paragraph) => (
            <p key={paragraph.id}>
              {paragraph.segments.map((segment, index) => (
                segment.annotationId ? (
                  <button
                    key={`${paragraph.id}-${index}`}
                    className="rss-annotation-anchor"
                    type="button"
                    aria-expanded={activeAnnotationId === segment.annotationId}
                    onClick={(event) => openAnnotation(
                      segment.annotationId!,
                      event.currentTarget,
                    )}
                  >
                    {segment.text}
                  </button>
                ) : segment.text
              ))}
            </p>
          ))}
        </div>
      ) : active ? (
        <div
          className="rss-trial-placeholder rss-trial-text-placeholder"
          role="status"
        >
          <span>正在放入试读原文…</span>
        </div>
      ) : null}

      {entry.afterReading ? (
        <section className="rss-reading-aid rss-after-reading">
          <span>AFTER READING · 读后想一想</span>
          <AssistanceContent content={entry.afterReading} />
        </section>
      ) : null}

      {entry.renderState === 'failed' || confirmError ? (
        <p className="rss-entry-error" role="alert">
          {confirmError ?? entry.error ?? '这次试读暂时没有准备好。'}
        </p>
      ) : null}

      {entry.renderState === 'ready' && entry.confirmation === 'available' ? (
        <InlineFeedback
          targetToolCallId={entry.toolCallId}
          commands={commands}
          disabled={!actionable || submitting}
        />
      ) : null}

      {entry.renderState === 'ready' && superseded ? (
        <p className="rss-artifact-superseded">
          这段后来又调整过了，继续看下面的新试读。
        </p>
      ) : null}

      {entry.renderState === 'ready' && !superseded ? (
        completed ? (
          <footer className="rss-trial-complete">
            <span aria-hidden="true">✓</span>
            <div>
              <strong>这段试读已经确认</strong>
              <p>这份确认已经记下，我会继续完成读前准备。</p>
            </div>
          </footer>
        ) : (
          <footer className="rss-confirm-row rss-trial-confirm">
            <button
              className="rss-primary-action"
              type="button"
              disabled={!actionable || submitting}
              onClick={() => void confirm()}
            >
              {submitting ? '正在确认…' : '就按这个方式，开始阅读'}
            </button>
            <p>如果读起来不对，我们还可以接着聊。</p>
          </footer>
        )
      ) : null}
      <NotePopover popover={annotationPopover} close={closeAnnotation} />
    </article>
  );
}
