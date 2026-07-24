/** Renders a progressively published strategy and its explicit feedback and confirmation actions. */

import { useState } from 'react';
import type { ReadingSetupCommands } from '../../session/types';
import type { StrategyTranscriptEntry } from '../../transcript/types';
import { InlineFeedback } from '../primitives/InlineFeedback';
import { StreamingCursor } from '../primitives/StreamingCursor';

function StrategyList({
  label,
  values,
  streaming,
}: {
  label: string;
  values: string[];
  streaming: boolean;
}) {
  return (
    <section className="rss-strategy-section" data-streaming={streaming || undefined}>
      <h3>{label}</h3>
      {values.length > 0 ? (
        <ul>
          {values.map((value, index) => (
            <li key={index}>
              {value}
              <StreamingCursor active={streaming && index === values.length - 1} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="rss-strategy-placeholder">
          正在整理…
          <StreamingCursor active={streaming} />
        </p>
      )}
    </section>
  );
}

export function StrategyEntry({
  entry,
  commands,
  interactionsLocked = false,
}: {
  entry: StrategyTranscriptEntry;
  commands: Pick<ReadingSetupCommands, 'sendFeedback' | 'confirmStrategy'>;
  interactionsLocked?: boolean;
}) {
  const [confirmPending, setConfirmPending] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const strategy = entry.strategy;
  const completed = entry.confirmation === 'completed';
  const superseded = entry.confirmation === 'superseded';
  const submitting = entry.confirmation === 'submitting' || confirmPending;
  const actionable = entry.renderState === 'ready'
    && entry.confirmation === 'available'
    && !interactionsLocked;

  const readingSupport = [
    ...(strategy?.guide?.enabled
      ? strategy.guide.objectives?.map((value) => `进入段落前：${value}`) ?? []
      : []),
    ...(strategy?.annotations?.enabled
      ? strategy.annotations.focuses?.map((value) => `阅读中：${value}`) ?? []
      : []),
    ...(strategy?.afterReading?.enabled
      ? strategy.afterReading.objectives?.map((value) => `读完后：${value}`) ?? []
      : []),
  ];
  const restraint = [
    ...(strategy?.expressionPrinciples ?? []),
    ...(strategy?.annotations?.exclusions?.map(
      (value) => `不额外解释：${value}`,
    ) ?? []),
  ];
  const planSections = [
    {
      key: 'goals',
      label: '这次阅读要带走什么',
      values: strategy?.goals ?? [],
    },
    {
      key: 'readingSupport',
      label: '阅读时我会做什么',
      values: readingSupport,
    },
    {
      key: 'restraint',
      label: '我会保持克制的地方',
      values: restraint,
    },
  ] as const;
  const inferredStreamingSection = [...planSections]
    .reverse()
    .find((section) => section.values.length > 0)?.key ?? 'summary';
  const streamingSection = entry.streamingSection ?? (
    entry.summary ? inferredStreamingSection : 'summary'
  );
  const streamingPlanIndex = planSections.findIndex(
    (section) => section.key === streamingSection,
  );
  const visiblePlanSections = entry.renderState === 'streaming'
    && streamingPlanIndex >= 0
    ? planSections.slice(0, streamingPlanIndex + 1)
    : planSections.filter((section) => section.values.length > 0);

  const confirm = async () => {
    if (!actionable || confirmPending) return;
    setConfirmPending(true);
    setConfirmError(null);
    try {
      await commands.confirmStrategy(entry.toolCallId);
    } catch {
      setConfirmError('这个阅读方式还没有确认成功，再试一次就好。');
    } finally {
      setConfirmPending(false);
    }
  };

  return (
    <article className="rss-strategy-entry" data-state={entry.renderState}>
      <span className="rss-entry-kicker">阅读方式</span>
      <h2>我想这样陪你读这本书</h2>
      <p className="rss-strategy-summary">
        {entry.summary || (
          <span className="rss-entry-placeholder">正在形成处理方式…</span>
        )}
        <StreamingCursor
          active={entry.renderState === 'streaming' && streamingSection === 'summary'}
        />
      </p>

      <div className="rss-strategy-plan">
        {visiblePlanSections.map((section) => (
          <StrategyList
            key={section.key}
            label={section.label}
            values={section.values}
            streaming={
              entry.renderState === 'streaming'
              && streamingSection === section.key
            }
          />
        ))}
      </div>

      {entry.renderState === 'working' ? (
        <p className="rss-entry-status" role="status">我在检查这个方式能不能落到原文里…</p>
      ) : null}
      {entry.renderState === 'failed' || confirmError ? (
        <p className="rss-entry-error" role="alert">
          {confirmError ?? entry.error ?? '这个阅读方式暂时没有准备好。'}
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
          这版后来又调整过了，继续看下面的新版本。
        </p>
      ) : null}

      {entry.renderState === 'ready' && !superseded ? (
        <footer className="rss-confirm-row">
          <button
            className="rss-primary-action"
            type="button"
            disabled={!actionable || submitting || completed}
            onClick={() => void confirm()}
          >
            {completed
              ? '✓ 已确认这个阅读方式'
              : submitting
                ? '正在确认…'
                : '确认这个阅读方式'}
          </button>
          <p>
            {completed
              ? '好，这个方式我记下了，接下来就按它准备试读。'
              : '如果这个方式合适，告诉我一声就好。'}
          </p>
        </footer>
      ) : null}

    </article>
  );
}
