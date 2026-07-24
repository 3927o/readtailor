/** Renders a transcript-owned connection or run notice and only its explicitly projected action. */

import { useState } from 'react';
import type { ReadingSetupCommands } from '../../session/types';
import type { NoticeTranscriptEntry } from '../../transcript/types';

export function NoticeEntry({
  entry,
  commands,
}: {
  entry: NoticeTranscriptEntry;
  commands: Pick<ReadingSetupCommands, 'retryConnection'>;
}) {
  const [pending, setPending] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const retry = async () => {
    if (pending || entry.action?.kind !== 'retry_connection') return;
    setPending(true);
    setRetryError(null);
    try {
      await commands.retryConnection();
    } catch {
      setRetryError('还是没连上，再试一次就好。');
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="rss-notice-entry"
      data-tone={entry.tone}
      role={entry.tone === 'error' ? 'alert' : 'status'}
    >
      <p>{entry.message}</p>
      {entry.action?.kind === 'retry_connection' ? (
        <button type="button" disabled={pending} onClick={() => void retry()}>
          {pending ? '正在重连…' : entry.action.label}
        </button>
      ) : null}
      {retryError ? <span role="alert">{retryError}</span> : null}
    </div>
  );
}
