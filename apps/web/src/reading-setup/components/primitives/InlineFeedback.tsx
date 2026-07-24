/** Provides the shared underlined feedback affordance without introducing a chat composer. */

import {
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { ReadingSetupCommands } from '../../session/types';

type FeedbackCommands = Pick<ReadingSetupCommands, 'sendFeedback'>;

export function InlineFeedback({
  targetToolCallId,
  commands,
  disabled = false,
}: {
  targetToolCallId: string;
  commands: FeedbackCommands;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (submitting) return;
    setMessage('');
    setError(null);
    setOpen(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || disabled || submitting) return;

    setSubmitting(true);
    setError(null);
    try {
      await commands.sendFeedback({
        targetToolCallId,
        message: trimmed,
      });
      setMessage('');
      setOpen(false);
    } catch {
      setError('这句话没有发出去，再试一次就好。');
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  if (!open) {
    return (
      <button
        className="rss-feedback-trigger"
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        这里不太合适？告诉我
      </button>
    );
  }

  return (
    <div className="rss-feedback">
      <form className="rss-feedback-form" onSubmit={submit}>
        <textarea
          autoFocus
          rows={1}
          value={message}
          disabled={disabled || submitting}
          aria-label="反馈这个内容"
          placeholder="直接说哪里不对…"
          onChange={(event) => {
            setError(null);
            setMessage(event.target.value);
          }}
          onKeyDown={handleKeyDown}
        />
        <button
          type="submit"
          aria-label={submitting ? '正在提交反馈' : '提交反馈'}
          disabled={disabled || submitting || !message.trim()}
        >
          {submitting ? '…' : '→'}
        </button>
      </form>
      {error ? <p className="rss-feedback-error" role="alert">{error}</p> : null}
    </div>
  );
}
