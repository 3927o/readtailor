import { useCallback, useEffect, useRef, useState } from 'react';
import { streamQaAnswer, type QaAnchor } from './api';

// §8 问 AI — a minimal read-only Q&A entry for the reader. The user asks about the current
// on-screen node (or a highlighted selection); the answer streams in live. The agent may attach
// a *pending* strategy-change proposal, shown here display-only — the read-only loop never lands
// it (confirm/regenerate is deferred; see docs/project/phase6_ask_ai.md 步骤 4 暂缓).

interface QaTurn {
  question: string;
  answer: string;
  streaming: boolean;
  error?: string;
}

// The anchor is resolved lazily at ask time from the reader's live state (current node +
// selection), so it reflects where the reader actually is when they hit send.
export function AskAiPanel({
  userBookId,
  resolveAnchor,
  close,
}: {
  userBookId: string;
  resolveAnchor: () => QaAnchor | null;
  close: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<QaTurn[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [proposal, setProposal] = useState<string | null>(null);
  const [profileUpdated, setProfileUpdated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [anchorLabel, setAnchorLabel] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, proposal]);

  const ask = useCallback(async () => {
    const question = draft.trim();
    if (!question || busy) return;
    // The first question of a thread carries its anchor; follow-ups reuse the thread's anchor.
    const anchor = sessionId ? undefined : resolveAnchor() ?? undefined;
    if (!sessionId) {
      setAnchorLabel(anchor?.anchor === 'highlight' ? '基于划线内容' : anchor ? '基于当前屏幕' : null);
    }
    setDraft('');
    setBusy(true);
    const index = turns.length;
    setTurns((current) => [...current, { question, answer: '', streaming: true }]);
    const patch = (change: Partial<QaTurn>) =>
      setTurns((current) => current.map((turn, i) => (i === index ? { ...turn, ...change } : turn)));
    // Accumulate the answer in a ref: the SSE deltas fire faster than React commits, so reading
    // the previous answer off state would drop characters under batching.
    let answer = '';

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamQaAnswer(
        userBookId,
        { ...(sessionId ? { sessionId } : {}), question, ...(anchor ? { anchor } : {}) },
        {
          onSession: (id) => setSessionId(id),
          onAnswer: (chars) => {
            answer += chars;
            patch({ answer });
          },
          onProposal: (summary) => setProposal(summary),
          onProfileUpdated: () => setProfileUpdated(true),
          onDone: () => patch({ streaming: false }),
          onError: (message) => patch({ streaming: false, error: message }),
        },
        controller.signal,
      );
    } catch (error) {
      patch({ streaming: false, error: error instanceof Error ? error.message : '问 AI 请求失败' });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, draft, resolveAnchor, sessionId, turns.length, userBookId]);

  return (
    <aside className="reader-askai" aria-label="问 AI">
      <div className="reader-sheet-handle" aria-hidden="true" />
      <header>
        <strong>问 AI</strong>
        <button type="button" onClick={close} aria-label="关闭问 AI">×</button>
      </header>
      <div className="reader-askai-thread" ref={scrollRef}>
        {turns.length === 0 ? (
          <p className="reader-askai-hint">
            针对当前阅读内容或你划线的部分提问，我会结合本书与你的画像作答。
          </p>
        ) : null}
        {anchorLabel ? <p className="reader-askai-anchor">{anchorLabel}</p> : null}
        {turns.map((turn, i) => (
          <div className="reader-askai-turn" key={i}>
            <p className="reader-askai-question">{turn.question}</p>
            {turn.answer ? <p className="reader-askai-answer">{turn.answer}</p> : null}
            {turn.streaming && !turn.answer ? (
              <p className="reader-askai-answer reader-askai-typing">正在思考…</p>
            ) : null}
            {turn.error ? <p className="reader-askai-error">{turn.error}</p> : null}
          </div>
        ))}
        {proposal ? (
          <div className="reader-askai-proposal" role="note">
            <span>处理方式调整建议（待确认）</span>
            <p>{proposal}</p>
            <small>该建议已记录，确认与应用功能稍后开放。</small>
          </div>
        ) : null}
        {profileUpdated ? (
          <p className="reader-askai-note">已根据本次对话更新你的长期阅读画像。</p>
        ) : null}
      </div>
      <form
        className="reader-askai-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void ask();
            }
          }}
          placeholder={sessionId ? '继续追问…' : '就当前内容提问…'}
          rows={2}
          aria-label="输入问题"
        />
        <button type="submit" disabled={busy || draft.trim().length === 0}>
          {busy ? '回答中…' : '发送'}
        </button>
      </form>
    </aside>
  );
}
