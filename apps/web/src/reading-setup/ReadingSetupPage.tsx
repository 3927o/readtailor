/** Composes the formal session view and gently follows newly appended transcript entries. */

import { useEffect, useRef } from 'react';
import { useParams } from 'react-router';
import { ReadingSetupSessionFrame } from './components/ReadingSetupSessionFrame';
import { ReadingSetupTranscript } from './components/ReadingSetupTranscript';
import { useReadingSetupSession } from './session/useReadingSetupSession';

export function ReadingSetupPage() {
  const { id = '' } = useParams();
  const controller = useReadingSetupSession(id);
  const tailRef = useRef<HTMLSpanElement>(null);
  const followingRef = useRef(true);
  const previousEntryCount = useRef(controller.view.entries.length);

  useEffect(() => {
    const updateFollowing = () => {
      const distanceFromBottom = document.documentElement.scrollHeight
        - window.scrollY
        - window.innerHeight;
      followingRef.current = distanceFromBottom < 360;
    };
    updateFollowing();
    window.addEventListener('scroll', updateFollowing, { passive: true });
    return () => window.removeEventListener('scroll', updateFollowing);
  }, []);

  useEffect(() => {
    const entryCount = controller.view.entries.length;
    const appended = entryCount > previousEntryCount.current;
    previousEntryCount.current = entryCount;
    if (!appended || !followingRef.current) return;

    const frame = requestAnimationFrame(() => {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      tailRef.current?.scrollIntoView({
        behavior: reduceMotion ? 'auto' : 'smooth',
        block: 'end',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [controller.view.entries.length]);

  return (
    <ReadingSetupSessionFrame view={controller.view}>
      <div
        className="rss-transcript-mount"
        data-entry-count={controller.view.entries.length}
        data-interactions-locked={controller.view.interactionsLocked || undefined}
      >
        <ReadingSetupTranscript
          entries={controller.view.entries}
          commands={controller.commands}
          interactionsLocked={controller.view.interactionsLocked}
        />
        <span className="rss-transcript-tail" ref={tailRef} aria-hidden="true" />
      </div>
    </ReadingSetupSessionFrame>
  );
}
