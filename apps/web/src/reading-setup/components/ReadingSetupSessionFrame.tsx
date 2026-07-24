/** Provides the formal reading-setup page shell without knowing transcript entry implementations. */

import type { ReactNode } from 'react';
import { LibraryChrome } from '../../library/LibraryChrome';
import type {
  ReadingSetupBookView,
  ReadingSetupPageView,
} from '../session/types';
import '../reading-setup.css';

function BookContext({ book }: { book: ReadingSetupBookView }) {
  return (
    <p className="rss-book-context">
      正在准备《<strong>{book.title}</strong>》
      {book.authors.length ? <span>{book.authors.join(' · ')}</span> : null}
    </p>
  );
}

export function ReadingSetupSessionFrame({
  view,
  children,
}: {
  view: Pick<ReadingSetupPageView, 'book' | 'connection'>;
  children: ReactNode;
}) {
  const connected = view.connection === 'connected';
  const pending = view.connection === 'connecting' || view.connection === 'reconnecting';

  return (
    <LibraryChrome service={{ connected, pending }}>
      <main className="rss-page">
        <BookContext book={view.book} />
        <section className="rss-canvas" aria-live="polite">
          {children}
        </section>
      </main>
    </LibraryChrome>
  );
}
