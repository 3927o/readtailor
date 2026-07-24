/** Renders persisted reading-setup conversation history and the active Agent run projection. */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { indexAgentTranscript, reduceAgentRunEvent } from '@readtailor/agent-state';
import type {
  AgentJsonValue,
  AgentMessageDto,
  AgentRunDisplaySnapshot,
  AgentRunToolDisplay,
  PresentQuestionArguments,
} from '@readtailor/contracts';
import { Link, useNavigate, useParams } from 'react-router';
import { LibraryChrome } from '../library/LibraryChrome';
import {
  readingSetupKeys,
  createReadingSetupSession,
  submitReadingSetupAction,
  subscribeReadingSetupRun,
} from './api';
import { parsePartialJson } from './partial-json';
import './reading-setup.css';

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function realtimeDetails(result: AgentJsonValue | null): unknown {
  return object(result)?.details ?? result;
}

export function AgentDrivenReadingSetupPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: readingSetupKeys.sessionByBook(id),
    queryFn: () => createReadingSetupSession(id),
    enabled: Boolean(id),
    staleTime: 0,
  });
  const [activeRun, setActiveRun] = useState<AgentRunDisplaySnapshot | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const session = sessionQuery.data;

  useEffect(() => {
    const snapshot = session?.activeRun?.snapshot;
    if (snapshot) setActiveRun(snapshot);
    else if (session?.activeRun) {
      setActiveRun({
        runId: session.activeRun.runId,
        lastSequence: 0,
        status: session.activeRun.status,
        assistantText: '',
        assistantMessage: null,
        tools: [],
        error: null,
      });
    } else if (session) {
      setActiveRun((current) => current?.status === 'failed' ? current : null);
    }
  }, [session?.activeRun?.runId, session?.activeRun?.snapshot, session?.updatedAt]);

  useEffect(() => {
    if (!session || !activeRun || !['queued', 'running'].includes(activeRun.status)) return;
    const controller = new AbortController();
    let stopped = false;
    const observe = async () => {
      while (!stopped) {
        try {
          await subscribeReadingSetupRun({
            sessionId: session.id,
            runId: activeRun.runId,
            signal: controller.signal,
            onEvent(event) {
              setActiveRun((current) => reduceAgentRunEvent(current, event));
              setConnectionError(null);
              if (event.type === 'tool_execution_finished' && !event.isError) {
                const result = object(realtimeDetails(event.result));
                if (result?.workflowStatus === 'active_reading') {
                  void queryClient.invalidateQueries({ queryKey: ['user-books'] });
                  navigate(`/user-books/${encodeURIComponent(id)}/read`, {
                    replace: true,
                  });
                }
              }
              if (event.type === 'run_finished') {
                void queryClient.invalidateQueries({
                  queryKey: readingSetupKeys.sessionByBook(id),
                });
              }
            },
          });
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          setConnectionError(error instanceof Error ? error.message : '实时连接已中断');
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    };
    void observe();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [activeRun?.runId, activeRun?.status, id, navigate, queryClient, session?.id]);

  const sendMessage = async (message = composer) => {
    if (!session || !message.trim() || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const started = await submitReadingSetupAction(session.id, {
        type: 'message',
        text: message.trim(),
      });
      setComposer('');
      setActiveRun({
        runId: started.runId,
        lastSequence: 0,
        status: 'queued',
        assistantText: '',
        assistantMessage: null,
        tools: [],
        error: null,
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '消息提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  const answerQuestion = async (
    questionToolCallId: string,
    selectedOptionIds: string[],
    freeText: string | null,
  ) => {
    if (!session) return;
    setSubmitError(null);
    try {
      const started = await submitReadingSetupAction(session.id, {
        type: 'question_answer',
        questionToolCallId,
        selectedOptionIds,
        freeText,
      });
      setActiveRun({
        runId: started.runId,
        lastSequence: 0,
        status: 'queued',
        assistantText: '',
        assistantMessage: null,
        tools: [],
        error: null,
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '回答提交失败');
    }
  };

  const confirmStrategy = async (strategyToolCallId: string) => {
    if (!session) return;
    setSubmitError(null);
    try {
      const started = await submitReadingSetupAction(session.id, {
        type: 'confirmation',
        targetToolCallId: strategyToolCallId,
      });
      setActiveRun({
        runId: started.runId,
        lastSequence: 0,
        status: 'queued',
        assistantText: '',
        assistantMessage: null,
        tools: [],
        error: null,
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '策略确认失败');
    }
  };

  const confirmTrial = async (trialToolCallId: string) => {
    if (!session) return;
    setSubmitError(null);
    try {
      const started = await submitReadingSetupAction(session.id, {
        type: 'confirmation',
        targetToolCallId: trialToolCallId,
      });
      setActiveRun({
        runId: started.runId,
        lastSequence: 0,
        status: 'queued',
        assistantText: '',
        assistantMessage: null,
        tools: [],
        error: null,
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '最终确认失败');
    }
  };

  const busy = Boolean(activeRun && ['queued', 'running'].includes(activeRun.status));

  return (
    <LibraryChrome service={{ connected: !sessionQuery.isError, pending: sessionQuery.isPending }}>
      <main className="reading-setup-page">
        <header className="reading-setup-header">
          <div>
            <span>READING SETUP</span>
            <h1>和 AI 一起准备这本书</h1>
          </div>
          <Link to="/">返回书架</Link>
        </header>

        {sessionQuery.isPending ? <p className="reading-setup-status">正在恢复会话…</p> : null}
        {sessionQuery.isError ? (
          <section className="reading-setup-error">
            <p>{sessionQuery.error.message}</p>
            <button type="button" onClick={() => void sessionQuery.refetch()}>重试</button>
          </section>
        ) : null}

        {session ? (
          <section className="reading-setup-conversation" aria-live="polite">
            <PersistedHistory
              messages={session.agentState.messages}
              onAnswer={answerQuestion}
              onStrategyConfirm={confirmStrategy}
              onTrialConfirm={confirmTrial}
              interactionsEnabled={!busy}
            />
            {activeRun ? (
              <LiveRun snapshot={activeRun} />
            ) : null}
            {connectionError ? <p className="reading-setup-warning">{connectionError}，正在重连…</p> : null}
            {activeRun?.status === 'failed' ? (
              <section className="reading-setup-error">
                <p>{activeRun.error ?? '本轮运行失败，请重试。'}</p>
                <button type="button" onClick={() => void sessionQuery.refetch()}>恢复会话</button>
              </section>
            ) : null}
          </section>
        ) : null}

        {session ? (
          <form
            className="reading-setup-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <textarea
              value={composer}
              onChange={(event) => setComposer(event.target.value)}
              placeholder="告诉 AI 你的想法、反馈或想调整的地方…"
              maxLength={8000}
              disabled={busy || submitting}
            />
            <button type="submit" disabled={busy || submitting || !composer.trim()}>
              {busy ? 'AI 正在处理' : '发送'}
            </button>
          </form>
        ) : null}
        {submitError ? <p className="reading-setup-error-inline">{submitError}</p> : null}
      </main>
    </LibraryChrome>
  );
}

function PersistedHistory(props: {
  messages: AgentMessageDto[];
  interactionsEnabled: boolean;
  onAnswer(toolCallId: string, selected: string[], freeText: string | null): Promise<void>;
  onStrategyConfirm(toolCallId: string): Promise<void>;
  onTrialConfirm(toolCallId: string): Promise<void>;
}) {
  const tools = useMemo(() => indexAgentTranscript(props.messages), [props.messages]);
  return props.messages.map((message, messageIndex) => {
    if (message.role === 'toolResult') return null;
    if (message.role === 'user') {
      const text = typeof message.content === 'string'
        ? message.content
        : message.content.map((item) => item.text).join('');
      return <article className="agent-message agent-message-user" key={`message-${messageIndex}`}>{text}</article>;
    }
    const text = message.content
      .filter((content) => content.type === 'text')
      .map((content) => content.type === 'text' ? content.text : '')
      .join('');
    const calls = message.content.filter((content) => content.type === 'toolCall');
    return (
      <div className="agent-message-group" key={`message-${messageIndex}`}>
        {text ? <article className="agent-message agent-message-assistant">{text}</article> : null}
        {calls.map((call) => {
          if (call.type !== 'toolCall') return null;
          const record = tools.get(call.id);
          return (
            <ToolCard
              key={call.id}
              toolCallId={call.id}
              toolName={call.name}
              argumentsValue={call.arguments}
              result={record?.result ?? null}
              isError={record?.status === 'failed'}
              interactive={props.interactionsEnabled && record?.status === 'succeeded'}
              onAnswer={props.onAnswer}
              onStrategyConfirm={props.onStrategyConfirm}
              onTrialConfirm={props.onTrialConfirm}
            />
          );
        })}
      </div>
    );
  });
}

function LiveRun({ snapshot }: { snapshot: AgentRunDisplaySnapshot }) {
  return (
    <div className="agent-message-group agent-live-run" data-status={snapshot.status}>
      {snapshot.assistantText ? (
        <article className="agent-message agent-message-assistant">{snapshot.assistantText}</article>
      ) : null}
      {snapshot.tools.map((item) => (
        <LiveToolCard key={item.toolCallId} item={item} />
      ))}
      {snapshot.status === 'queued' && !snapshot.assistantText && snapshot.tools.length === 0 ? (
        <p className="reading-setup-status">AI 已接收，等待后台运行…</p>
      ) : null}
    </div>
  );
}

function LiveToolCard({ item }: { item: AgentRunToolDisplay }) {
  const progressive = item.arguments ?? parsePartialJson(item.argumentsBuffer);
  return (
    <ToolCard
      toolCallId={item.toolCallId}
      toolName={item.toolName}
      argumentsValue={progressive}
      result={realtimeDetails(item.result) as AgentJsonValue | null}
      isError={item.isError}
      interactive={false}
    />
  );
}

export function ToolCard(props: {
  toolCallId: string;
  toolName: string;
  argumentsValue: unknown;
  result: AgentJsonValue | null;
  isError: boolean;
  interactive: boolean;
  onAnswer?(toolCallId: string, selected: string[], freeText: string | null): Promise<void>;
  onStrategyConfirm?(toolCallId: string): Promise<void>;
  onTrialConfirm?(toolCallId: string): Promise<void>;
}) {
  const args = object(props.argumentsValue);
  const title: Record<string, string> = {
    present_question: 'AI 想了解',
    publish_brief: '阅读简报',
    publish_book_reader_profile: '这本书与你',
    publish_strategy: '建议的阅读方式',
    generate_trial_slice: '片段试读',
    complete_reading_setup: '完成阅读准备',
  };
  if (props.toolName === 'present_question' && args) {
    return (
      <QuestionCard
        toolCallId={props.toolCallId}
        args={args as unknown as PresentQuestionArguments}
        enabled={props.interactive}
        {...(props.onAnswer ? { onAnswer: props.onAnswer } : {})}
      />
    );
  }
  return (
    <article className="agent-tool-card" data-tool={props.toolName} data-error={props.isError || undefined}>
      <h2>{title[props.toolName] ?? `工具：${props.toolName}`}</h2>
      <ToolBody toolName={props.toolName} args={args} result={props.result} />
      {props.toolName === 'publish_strategy' ? (
        <button
          type="button"
          disabled={!props.interactive}
          onClick={() => void props.onStrategyConfirm?.(props.toolCallId)}
        >
          确认这个阅读方式
        </button>
      ) : null}
      {props.toolName === 'generate_trial_slice' ? (
        <button
          type="button"
          disabled={!props.interactive}
          onClick={() => void props.onTrialConfirm?.(props.toolCallId)}
        >
          就按这个方式，开始阅读
        </button>
      ) : null}
      {props.isError ? <p className="reading-setup-error-inline">工具执行失败</p> : null}
    </article>
  );
}

function ToolBody(props: {
  toolName: string;
  args: Record<string, unknown> | null;
  result: AgentJsonValue | null;
}) {
  const { toolName, args } = props;
  if (!args) return <p>参数正在生成…</p>;
  if (toolName === 'publish_brief') return <JsonSections value={args.brief} />;
  if (toolName === 'publish_book_reader_profile') return <JsonSections value={args.profile} />;
  if (toolName === 'publish_strategy') {
    return <><p>{String(args.summary ?? '')}</p><JsonSections value={args.strategy} /></>;
  }
  if (toolName === 'generate_trial_slice') {
    const result = object(props.result);
    const source = object(result?.source);
    return (
      <>
        <p>{String(args.reason ?? '')}</p>
        {source?.text ? <blockquote>{String(source.text)}</blockquote> : <p>试读正在生成…</p>}
        {result ? <JsonSections value={{
          guide: result.guide,
          annotations: result.annotations,
          afterReading: result.afterReading,
        }} /> : null}
      </>
    );
  }
  return <pre>{JSON.stringify({ arguments: args, result: props.result }, null, 2)}</pre>;
}

function JsonSections({ value }: { value: unknown }) {
  const entries = Object.entries(object(value) ?? {});
  return (
    <dl>
      {entries.map(([key, item]) => (
        <div key={key}><dt>{key}</dt><dd>{typeof item === 'string' ? item : JSON.stringify(item)}</dd></div>
      ))}
    </dl>
  );
}

function QuestionCard(props: {
  toolCallId: string;
  args: PresentQuestionArguments;
  enabled: boolean;
  onAnswer?(toolCallId: string, selected: string[], freeText: string | null): Promise<void>;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState('');
  const toggle = (id: string) => {
    setSelected((current) =>
      props.args.selectionMode === 'single'
        ? [id]
        : current.includes(id)
          ? current.filter((item) => item !== id)
          : [...current, id],
    );
  };
  return (
    <article className="agent-tool-card agent-question-card">
      <h2>AI 想了解</h2>
      <p>{props.args.prompt}</p>
      {props.args.hint ? <small>{props.args.hint}</small> : null}
      <div className="agent-question-options">
        {props.args.options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={selected.includes(option.id)}
            disabled={!props.enabled}
            onClick={() => toggle(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {props.args.allowFreeText ? (
        <textarea
          value={freeText}
          disabled={!props.enabled}
          maxLength={4000}
          placeholder="也可以补充说明"
          onChange={(event) => setFreeText(event.target.value)}
        />
      ) : null}
      <button
        type="button"
        disabled={!props.enabled || (selected.length === 0 && !freeText.trim())}
        onClick={() => void props.onAnswer?.(
          props.toolCallId,
          selected,
          freeText.trim() || null,
        )}
      >
        提交回答
      </button>
    </article>
  );
}
