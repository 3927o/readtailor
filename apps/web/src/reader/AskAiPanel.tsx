import { useCallback, useEffect, useRef, useState } from 'react';
import {
  confirmQaProposal,
  feedbackQaProposal,
  getQaSession,
  listQaSessions,
  rejectQaProposal,
  streamQaAnswer,
} from './api';
import type {
  NodeEnhancementStatus,
  QaProposalRevisionSummary,
  QaProposalStreamEvent,
  QaQuestionContext,
  QaSessionListItem,
  QaSessionResponse,
  StrategyChangeProposalStatus,
} from './api';

interface ProposalCardData {
  id: string;
  proposalId: string;
  revision: number;
  triggeringMessageId: string;
  publicSummary: string;
  status: StrategyChangeProposalStatus;
}

interface QaTurn {
  key: string;
  question: string;
  answer: string;
  streaming: boolean;
  idempotencyKey?: string | undefined;
  messageId?: string | undefined;
  proposalRevision?: ProposalCardData | undefined;
  error?: string | undefined;
}

interface ActiveProposal {
  proposalId: string;
  revisionId: string;
  revision: number;
  status: StrategyChangeProposalStatus;
}

interface FeedbackTarget {
  proposalId: string;
  revisionId: string;
}

type ProposalAction = 'feedback' | 'confirm' | 'reject';

export function proposalActionIdempotencyKey(
  cache: Map<string, string>,
  createKey: () => string,
  action: ProposalAction,
  proposalId: string,
  revisionId: string,
  payload?: string,
): string {
  const scope = JSON.stringify([action, proposalId, revisionId, payload ?? null]);
  const existing = cache.get(scope);
  if (existing) return existing;
  const created = createKey();
  cache.set(scope, created);
  return created;
}

function proposalFromRevision(revision: QaProposalRevisionSummary): ProposalCardData {
  return {
    id: revision.id,
    proposalId: revision.proposalId,
    revision: revision.revision,
    triggeringMessageId: revision.triggeringMessageId,
    publicSummary: revision.publicSummary,
    status: revision.status,
  };
}

function proposalFromEvent(event: QaProposalStreamEvent): ProposalCardData {
  return {
    id: event.revisionId,
    proposalId: event.proposalId,
    revision: event.revision,
    triggeringMessageId: event.triggeringMessageId,
    publicSummary: event.publicSummary,
    status: event.status,
  };
}

export function turnsFromQaSession(session: QaSessionResponse): QaTurn[] {
  const turns: QaTurn[] = [];
  for (const message of [...session.messages].sort((left, right) => left.sequence - right.sequence)) {
    if (message.role === 'user') {
      turns.push({
        key: message.id,
        question: message.content,
        answer: '',
        streaming: false,
      });
      continue;
    }
    const turn = [...turns].reverse().find((candidate) => !candidate.answer && !candidate.messageId);
    const answerTurn = turn ?? {
      key: message.id,
      question: '',
      answer: '',
      streaming: false,
    };
    answerTurn.answer = message.content;
    answerTurn.messageId = message.id;
    answerTurn.proposalRevision = message.proposalRevision
      ? proposalFromRevision(message.proposalRevision)
      : undefined;
    if (!turn) turns.push(answerTurn);
  }
  return turns;
}

function contextLabel(context: QaQuestionContext): string {
  return context.anchor === 'highlight' ? '划线原文 · 精确范围' : '当前屏幕 · 近似范围';
}

function proposalStatusLabel(status: StrategyChangeProposalStatus): string {
  if (status === 'confirmed') return '已确认';
  if (status === 'rejected') return '已取消';
  if (status === 'superseded') return '已失效';
  return '等待确认';
}

function generationStatusLabel(status: NodeEnhancementStatus | undefined): string | null {
  if (status === 'queued') return '当前内容已进入生成队列。';
  if (status === 'generating') return '当前内容正在按新方式生成。';
  if (status === 'failed') return '当前内容生成失败，原文仍可阅读。';
  if (status === 'ready') return '当前内容已按新方式更新。';
  return null;
}

export function AskAiPanel({
  userBookId,
  initialContext,
  strategyStatus,
  returnToSource,
  refreshBootstrap,
  close,
}: {
  userBookId: string;
  initialContext: QaQuestionContext | null;
  strategyStatus?: NodeEnhancementStatus | undefined;
  returnToSource: (context: QaQuestionContext) => void;
  refreshBootstrap: () => Promise<unknown>;
  close: () => void;
}) {
  const initialContextRef = useRef(initialContext);
  const [context, setContext] = useState<QaQuestionContext | null>(initialContext);
  const [draft, setDraft] = useState('');
  const [turns, setTurns] = useState<QaTurn[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sessions, setSessions] = useState<QaSessionListItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [activeProposal, setActiveProposal] = useState<ActiveProposal | null>(null);
  const [feedbackTarget, setFeedbackTarget] = useState<FeedbackTarget | null>(null);
  const [proposalBusy, setProposalBusy] = useState<string | null>(null);
  const [proposalErrors, setProposalErrors] = useState<Record<string, string>>({});
  const [profileUpdated, setProfileUpdated] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const actionKeysRef = useRef(new Map<string, string>());

  const idempotencyFor = useCallback((
    action: ProposalAction,
    proposalId: string,
    revisionId: string,
    payload?: string,
  ) => proposalActionIdempotencyKey(
    actionKeysRef.current,
    () => crypto.randomUUID(),
    action,
    proposalId,
    revisionId,
    payload,
  ), []);

  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns, confirmed, feedbackTarget]);
  useEffect(() => {
    if (feedbackTarget) inputRef.current?.focus();
  }, [feedbackTarget]);

  const loadSessions = useCallback(async () => {
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const response = await listQaSessions(userBookId, { limit: 30 });
      setSessions(response.sessions);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '问答历史读取失败');
    } finally {
      setHistoryBusy(false);
    }
  }, [userBookId]);

  useEffect(() => { void loadSessions(); }, [loadSessions]);

  const patchTurn = useCallback((index: number, patch: Partial<QaTurn>) => {
    setTurns((current) => current.map((turn, turnIndex) => (
      turnIndex === index ? { ...turn, ...patch } : turn
    )));
  }, []);

  const updateProposalStatus = useCallback((proposalId: string, revisionId: string, status: StrategyChangeProposalStatus) => {
    setTurns((current) => current.map((turn) => (
      turn.proposalRevision?.proposalId === proposalId && turn.proposalRevision.id === revisionId
        ? { ...turn, proposalRevision: { ...turn.proposalRevision, status } }
        : turn
    )));
    setActiveProposal((current) => current?.proposalId === proposalId && current.revisionId === revisionId
      ? { ...current, status }
      : current);
  }, []);

  const runTurn = useCallback(async (
    index: number,
    question: string,
    idempotencyKey: string,
    requestSessionId: string | undefined,
  ) => {
    if (!requestSessionId && !context) {
      patchTurn(index, { streaming: false, error: '当前原文上下文不可用，请关闭后重新打开问 AI。' });
      return;
    }
    setBusy(true);
    patchTurn(index, { answer: '', streaming: true, error: undefined, proposalRevision: undefined });
    let answer = '';
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await streamQaAnswer(
        userBookId,
        {
          question,
          idempotencyKey,
          ...(requestSessionId ? { sessionId: requestSessionId } : { context: context! }),
        },
        {
          onSession: (id) => {
            sessionIdRef.current = id;
            setSessionId(id);
          },
          onAnswer: (chars) => {
            answer += chars;
            patchTurn(index, { answer });
          },
          onProposal: (proposal) => {
            const revision = proposalFromEvent(proposal);
            setTurns((current) => current.map((turn, turnIndex) => {
              const prior = turn.proposalRevision;
              const nextTurn = prior?.proposalId === proposal.proposalId && prior.status === 'pending'
                ? { ...turn, proposalRevision: { ...prior, status: 'superseded' as const } }
                : turn;
              return turnIndex === index ? { ...nextTurn, proposalRevision: revision } : nextTurn;
            }));
            setActiveProposal({
              proposalId: proposal.proposalId,
              revisionId: proposal.revisionId,
              revision: proposal.revision,
              status: proposal.status,
            });
          },
          onProfileUpdated: () => setProfileUpdated(true),
          onDone: (messageId) => patchTurn(index, { streaming: false, messageId, error: undefined }),
          onError: (message) => {
            patchTurn(index, { streaming: false, error: message });
          },
        },
        controller.signal,
      );
      void loadSessions();
    } catch (error) {
      if (controller.signal.aborted) return;
      patchTurn(index, {
        streaming: false,
        error: error instanceof Error ? error.message : '问 AI 请求失败',
      });
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [context, loadSessions, patchTurn, userBookId]);

  const enqueueQuestion = useCallback((question: string) => {
    const index = turns.length;
    const idempotencyKey = crypto.randomUUID();
    setTurns((current) => [...current, {
      key: idempotencyKey,
      question,
      answer: '',
      streaming: true,
      idempotencyKey,
    }]);
    void runTurn(index, question, idempotencyKey, sessionIdRef.current);
  }, [runTurn, turns.length]);

  const submit = useCallback(async () => {
    const question = draft.trim();
    if (!question || busy || proposalBusy) return;
    setDraft('');
    if (feedbackTarget) {
      setProposalBusy(feedbackTarget.revisionId);
      try {
        await feedbackQaProposal(userBookId, feedbackTarget.proposalId, {
          revisionId: feedbackTarget.revisionId,
          feedback: question,
          idempotencyKey: idempotencyFor(
            'feedback',
            feedbackTarget.proposalId,
            feedbackTarget.revisionId,
            question,
          ),
        });
        setFeedbackTarget(null);
      } catch (error) {
        setDraft(question);
        setProposalErrors((current) => ({
          ...current,
          [feedbackTarget.revisionId]: error instanceof Error ? error.message : '反馈提交失败',
        }));
        setProposalBusy(null);
        return;
      }
      setProposalBusy(null);
    }
    enqueueQuestion(question);
  }, [busy, draft, enqueueQuestion, feedbackTarget, idempotencyFor, proposalBusy, userBookId]);

  const restoreSession = async (targetSessionId: string) => {
    if (busy) return;
    setHistoryBusy(true);
    setHistoryError(null);
    try {
      const session = await getQaSession(userBookId, targetSessionId);
      setSessionId(session.sessionId);
      sessionIdRef.current = session.sessionId;
      setContext(session.questionContext);
      setTurns(turnsFromQaSession(session));
      setActiveProposal(session.proposal ? {
        proposalId: session.proposal.id,
        revisionId: session.proposal.currentRevisionId,
        revision: session.proposal.revision,
        status: session.proposal.status,
      } : null);
      setFeedbackTarget(null);
      setConfirmed(session.proposal?.status === 'confirmed');
      setHistoryOpen(false);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : '问答会话读取失败');
    } finally {
      setHistoryBusy(false);
    }
  };

  const newSession = () => {
    abortRef.current?.abort();
    sessionIdRef.current = undefined;
    setSessionId(undefined);
    setContext(initialContextRef.current);
    setTurns([]);
    setActiveProposal(null);
    setFeedbackTarget(null);
    setProfileUpdated(false);
    setConfirmed(false);
    setHistoryOpen(false);
    setDraft('');
  };

  const decideProposal = async (proposal: ProposalCardData, action: 'confirm' | 'reject') => {
    setProposalBusy(proposal.id);
    setProposalErrors((current) => ({ ...current, [proposal.id]: '' }));
    try {
      const input = {
        revisionId: proposal.id,
        idempotencyKey: idempotencyFor(action, proposal.proposalId, proposal.id),
      };
      const response = action === 'confirm'
        ? await confirmQaProposal(userBookId, proposal.proposalId, input)
        : await rejectQaProposal(userBookId, proposal.proposalId, input);
      updateProposalStatus(response.proposalId, response.revisionId, response.status);
      if (response.status === 'confirmed') {
        setConfirmed(true);
        await refreshBootstrap();
      }
      void loadSessions();
    } catch (error) {
      setProposalErrors((current) => ({
        ...current,
        [proposal.id]: error instanceof Error ? error.message : '建议操作失败',
      }));
    } finally {
      setProposalBusy(null);
    }
  };

  return (
    <aside className="reader-askai" aria-label="问 AI">
      <div className="reader-sheet-handle" aria-hidden="true" />
      <header>
        <strong>问 AI</strong>
        <div className="reader-askai-header-actions">
          {sessionId || turns.length ? <button type="button" onClick={newSession}>新对话</button> : null}
          <button type="button" onClick={() => setHistoryOpen((open) => !open)}>历史</button>
          <button type="button" onClick={close} aria-label="关闭问 AI">×</button>
        </div>
      </header>

      {historyOpen ? (
        <div className="reader-askai-history">
          {historyBusy ? <p>正在读取历史…</p> : null}
          {!historyBusy && sessions.length === 0 ? <p>还没有问答记录。</p> : null}
          {sessions.map((session) => (
            <button type="button" key={session.sessionId} onClick={() => void restoreSession(session.sessionId)}>
              <span>{session.question}</span>
              <small>{session.messageCount} 条消息</small>
            </button>
          ))}
          {historyError ? <p className="reader-askai-error">{historyError}</p> : null}
        </div>
      ) : null}

      {context ? (
        <details className="reader-askai-source">
          <summary>{contextLabel(context)}</summary>
          <blockquote>{context.quoteSnapshot || '该位置没有可展示的文本快照。'}</blockquote>
          <button type="button" onClick={() => returnToSource(context)}>返回原文</button>
        </details>
      ) : (
        <p className="reader-askai-error">当前原文上下文不可用，请关闭后重新打开。</p>
      )}

      <div className="reader-askai-thread" ref={scrollRef}>
        {turns.length === 0 ? (
          <p className="reader-askai-hint">还没有消息。</p>
        ) : null}
        {turns.map((turn, index) => {
          const proposal = turn.proposalRevision;
          const isCurrent = Boolean(proposal
            && activeProposal?.proposalId === proposal.proposalId
            && activeProposal.revisionId === proposal.id
            && activeProposal.status === 'pending');
          return (
            <div className="reader-askai-turn" key={turn.key}>
              {turn.question ? <p className="reader-askai-question">{turn.question}</p> : null}
              {turn.answer ? <p className="reader-askai-answer">{turn.answer}</p> : null}
              {turn.streaming && !turn.answer ? (
                <p className="reader-askai-answer reader-askai-typing">正在思考…</p>
              ) : null}
              {turn.error ? (
                <div className="reader-askai-turn-error">
                  <p className="reader-askai-error">{turn.error}</p>
                  {turn.idempotencyKey ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void runTurn(index, turn.question, turn.idempotencyKey!, sessionIdRef.current)}
                    >
                      重试
                    </button>
                  ) : null}
                </div>
              ) : null}
              {proposal ? (
                <div className="reader-askai-proposal" role="note">
                  <span>处理方式建议 · 修订 {proposal.revision}</span>
                  <p>{proposal.publicSummary}</p>
                  <small>{proposalStatusLabel(proposal.status)}</small>
                  {isCurrent ? (
                    <div className="reader-askai-proposal-actions">
                      <button type="button" disabled={proposalBusy === proposal.id} onClick={() => void decideProposal(proposal, 'confirm')}>确认调整</button>
                      <button
                        type="button"
                        disabled={proposalBusy === proposal.id}
                        onClick={() => {
                          setFeedbackTarget({
                            proposalId: proposal.proposalId,
                            revisionId: proposal.id,
                          });
                          setDraft('');
                        }}
                      >
                        反馈
                      </button>
                      <button type="button" disabled={proposalBusy === proposal.id} onClick={() => void decideProposal(proposal, 'reject')}>取消建议</button>
                    </div>
                  ) : null}
                  {proposalErrors[proposal.id] ? <p className="reader-askai-error">{proposalErrors[proposal.id]}</p> : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {profileUpdated ? <p className="reader-askai-note">已更新你的长期阅读画像。</p> : null}
        {confirmed ? (
          <div className="reader-askai-confirmed" role="status">
            <strong>处理方式已更新，当前及后续内容将按新方式生成。</strong>
            {generationStatusLabel(strategyStatus) ? <p>{generationStatusLabel(strategyStatus)}</p> : null}
          </div>
        ) : null}
      </div>

      <form
        className="reader-askai-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={feedbackTarget ? '说明希望怎样调整…' : sessionId ? '继续追问…' : '就冻结的原文提问…'}
          rows={2}
          aria-label={feedbackTarget ? '输入建议反馈' : '输入问题'}
        />
        <button type="submit" disabled={busy || Boolean(proposalBusy) || draft.trim().length === 0 || (!sessionId && !context)}>
          {busy ? '回答中…' : feedbackTarget ? '提交反馈' : '发送'}
        </button>
      </form>
    </aside>
  );
}
