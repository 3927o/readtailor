/** Renders only the transient, quiet activity line for an active Agent book query. */

import type { QueryTranscriptEntry } from '../../transcript/types';

export function QueryActivityEntry({ entry }: { entry: QueryTranscriptEntry }) {
  if (entry.renderState === 'failed') return null;

  return (
    <p className="rss-query-entry" role="status">
      <span className="rss-query-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {entry.activity}…
    </p>
  );
}
