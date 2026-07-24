/** Renders one Agent question and owns only its temporary, pre-submission form values. */

import {
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { ReadingSetupCommands } from '../../session/types';
import type { QuestionTranscriptEntry } from '../../transcript/types';
import { StreamingCursor } from '../primitives/StreamingCursor';

type QuestionCommands = Pick<ReadingSetupCommands, 'answerQuestion'>;

function questionHeading(entry: QuestionTranscriptEntry): string {
  if (entry.prompt) return entry.prompt;
  if (entry.renderState === 'streaming' || entry.renderState === 'working') {
    return '我正在想，先从哪件事问起';
  }
  return '我想先问你一件事';
}

export function QuestionEntry({
  entry,
  commands,
  interactionsLocked = false,
}: {
  entry: QuestionTranscriptEntry;
  commands: QuestionCommands;
  interactionsLocked?: boolean;
}) {
  const [selectedOptionIds, setSelectedOptionIds] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  const answered = Boolean(entry.answer);
  const ready = entry.renderState === 'ready';
  const active = entry.renderState === 'streaming' || entry.renderState === 'working';
  const streamingPart = entry.streamingPart ?? (
    entry.options.length > 0
      ? 'options'
      : entry.hint
        ? 'hint'
        : 'prompt'
  );
  const enabled = ready && !answered && !interactionsLocked && !submitting;
  const canSubmitFreeText = Boolean(freeText.trim());
  const formVisible = (ready || active)
    && !answered
    && (entry.options.length > 0 || Boolean(entry.allowFreeText));

  const submitAnswer = async (
    optionIds: string[],
    answerText: string | null,
  ) => {
    if (!enabled || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmissionError(null);
    try {
      await commands.answerQuestion({
        toolCallId: entry.toolCallId,
        selectedOptionIds: optionIds,
        freeText: answerText,
      });
    } catch {
      setSelectedOptionIds([]);
      setSubmissionError('回答没有发出去，再试一次就好。');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const selectOption = (optionId: string) => {
    if (!enabled || submittingRef.current) return;
    setSelectedOptionIds([optionId]);
    void submitAnswer([optionId], null);
  };

  const submitFreeText = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = freeText.trim();
    if (!trimmed) return;
    void submitAnswer([], trimmed);
  };

  const submitOnEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  const visibleError = submissionError ?? entry.error;

  return (
    <section
      className="rss-question-entry"
      data-state={entry.renderState}
      data-answered={answered || undefined}
      aria-labelledby={`${entry.id}-prompt`}
      aria-busy={active || submitting || undefined}
    >
      <h2 id={`${entry.id}-prompt`}>
        {questionHeading(entry)}
        <StreamingCursor
          active={entry.renderState === 'streaming' && streamingPart === 'prompt'}
        />
      </h2>
      {entry.hint ? (
        <p className="rss-question-hint">
          {entry.hint}
          <StreamingCursor
            active={entry.renderState === 'streaming' && streamingPart === 'hint'}
          />
        </p>
      ) : null}

      {formVisible ? (
        <form onSubmit={submitFreeText}>
          {entry.options.length > 0 ? (
            <div className="rss-question-options">
              {entry.options.map((option, index) => {
                const selected = selectedOptionIds.includes(option.id);
                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={selected}
                    disabled={!enabled}
                    style={{ '--rss-option-index': index } as CSSProperties}
                    onClick={() => selectOption(option.id)}
                  >
                    <span className="rss-question-option-mark" aria-hidden="true">
                      {selected ? '✓' : '↳'}
                    </span>
                    {option.label}
                    <StreamingCursor
                      active={
                        entry.renderState === 'streaming'
                        && streamingPart === 'options'
                        && index === entry.options.length - 1
                      }
                    />
                  </button>
                );
              })}
            </div>
          ) : null}

          {entry.allowFreeText ? (
            <div className="rss-question-compose">
              <span aria-hidden="true">↳</span>
              <textarea
                rows={1}
                value={freeText}
                disabled={!enabled}
                aria-label="补充自己的想法"
                placeholder={entry.options.length ? '或者，直接说说你的想法…' : '直接说说你的想法…'}
                onChange={(event) => {
                  setSubmissionError(null);
                  setFreeText(event.target.value);
                }}
                onKeyDown={submitOnEnter}
              />
              <button
                type="submit"
                aria-label={submitting ? '正在提交回答' : '提交回答'}
                disabled={!enabled || !canSubmitFreeText}
              >
                {submitting ? '…' : '→'}
              </button>
            </div>
          ) : null}
        </form>
      ) : null}

      {visibleError ? (
        <p className="rss-question-error" role="alert">{visibleError}</p>
      ) : null}
    </section>
  );
}
