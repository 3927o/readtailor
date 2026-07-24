/** Renders a minimal fallback so an unknown Agent Tool never breaks the transcript. */

import type { GenericToolTranscriptEntry } from '../../transcript/types';

export function GenericToolEntry({ entry }: { entry: GenericToolTranscriptEntry }) {
  const active = entry.renderState === 'streaming' || entry.renderState === 'working';
  return (
    <div
      className="rss-notice-entry"
      data-tone={entry.renderState === 'failed' ? 'error' : 'quiet'}
    >
      <p>
        {active ? '正在执行' : entry.renderState === 'failed' ? '执行失败' : '已完成'}
        ：{entry.toolName}
      </p>
      {entry.error ? <span role="alert">{entry.error}</span> : null}
    </div>
  );
}
