/** Renders an answer or feedback as a lightweight user turn without chat-bubble chrome. */

import type { UserTranscriptEntry } from '../../transcript/types';

const DELIVERY_LABEL = {
  sending: '发送中',
  failed: '没发出去',
} as const;

export function UserEntry({ entry }: { entry: UserTranscriptEntry }) {
  const deliveryLabel = entry.delivery === 'sent'
    ? null
    : DELIVERY_LABEL[entry.delivery];

  return (
    <div className="rss-user-entry" data-delivery={entry.delivery}>
      <p>{entry.text}</p>
      {deliveryLabel ? (
        <span className="rss-user-delivery" role="status">
          {deliveryLabel}
        </span>
      ) : null}
    </div>
  );
}
