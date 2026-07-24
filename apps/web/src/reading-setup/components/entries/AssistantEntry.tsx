/** Renders an Assistant transcript turn as part of the continuous preparation document. */

import { AssistanceContent } from '../../../user-books/components';
import type { AssistantTranscriptEntry } from '../../transcript/types';
import { StreamingCursor } from '../primitives/StreamingCursor';

export function AssistantEntry({
  entry,
}: {
  entry: AssistantTranscriptEntry;
}) {
  return (
    <div className="rss-assistant-entry" data-streaming={entry.streaming || undefined}>
      <AssistanceContent
        content={entry.text}
        trailing={<StreamingCursor active={entry.streaming} />}
      />
    </div>
  );
}
