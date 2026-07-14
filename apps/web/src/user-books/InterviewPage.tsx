import { useEffect, useState, type CSSProperties } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { ApiError, getInterview, streamInterviewAnswer } from './api';
import type { InterviewOption, InterviewQuestion } from './api';
import { WorkflowFallback, WorkflowMessage, WorkflowPage } from './components';
import { useWorkflowGate } from './useWorkflowGate';

// Live state accumulated from the SSE turn (§4.3): the acknowledgment and prompt arrive one
// fragment at a time, options stagger in, and the agent reports its own information
// sufficiency. The interaction form follows the prototype's interview screen
// (design/prototypes/readtailor-mvp.dc.html, screen 05): a conversation that materializes
// token by token, where the agent decides when it has heard enough.
interface StreamState {
  active: boolean;
  concluding: boolean;
  ack: string;
  prompt: string;
  hint: string;
  options: InterviewOption[];
  sufficiency: number | null;
}

const IDLE_STREAM: StreamState = { active: false, concluding: false, ack: '', prompt: '', hint: '', options: [], sufficiency: null };

// A turn the reader just answered, recorded locally so it appears in the history immediately
// (and with the option label / text we already hold) instead of waiting for the server refetch.
interface LocalTurn {
  questionId: string;
  question: string;
  answer: string;
}

function clampPercent(value: number | null): number {
  return value === null ? 0 : Math.max(0, Math.min(100, Math.round(value)));
}

// Per-character reveal matching the prototype's `rtChar` blur-up. Characters are keyed by
// position, so as the streamed text grows React mounts only the newly arrived characters and
// each one animates in on arrival — the materialize-as-you-type feel, driven by real tokens.
// A visually-hidden copy carries the whole string for assistive technology.
function Typeset({ text }: { text: string }) {
  return (
    <>
      <span className="visually-hidden">{text}</span>
      <span aria-hidden="true">
        {Array.from(text).map((char, index) => (
          <span key={index} className="interview-char">{char}</span>
        ))}
      </span>
    </>
  );
}

export function InterviewPage() {
  const { id = '' } = useParams();
  const gate = useWorkflowGate(id, ['on_shelf', 'interviewing']);
  const queryClient = useQueryClient();
  const interview = useQuery({
    queryKey: ['user-book', id, 'interview'],
    queryFn: () => getInterview(id),
    enabled: gate.active,
    refetchInterval: (current) => current.state.data?.status === 'completing' ? 1800 : false,
  });
  const [text, setText] = useState('');
  const [stream, setStream] = useState<StreamState>(IDLE_STREAM);
  // A monotonic turn counter keys the current-turn container. It changes only when the reader
  // sends an answer, so the streamed prompt stays mounted as it settles into the final
  // question (no re-animation), while each new turn re-materializes from scratch.
  const [turnSeq, setTurnSeq] = useState(0);
  // Authoritative next question from question_final — overrides the query's currentQuestion
  // until the next submit, so the interactive turn appears without a refetch flash.
  const [activeQuestion, setActiveQuestion] = useState<InterviewQuestion | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  // Turns answered in this session, keyed by question id. Preferred over the server snapshot so
  // the history reflects the answer the instant it's sent.
  const [localHistory, setLocalHistory] = useState<LocalTurn[]>([]);

  const question = activeQuestion ?? interview.data?.currentQuestion ?? null;

  useEffect(() => {
    setText('');
  }, [question?.id]);

  const answer = useMutation<void, Error, { questionId: string; optionId?: string; text?: string }>({
    mutationFn: (input) => streamInterviewAnswer(id, input, {
      onAck: (chars) => setStream((s) => ({ ...s, ack: s.ack + chars })),
      onPrompt: (chars) => setStream((s) => ({ ...s, prompt: s.prompt + chars })),
      onHint: (chars) => setStream((s) => ({ ...s, hint: s.hint + chars })),
      onOption: (option) => setStream((s) => ({ ...s, options: [...s.options, option] })),
      onSufficiency: (value) => setStream((s) => ({ ...s, sufficiency: value })),
      onConcluding: () => setStream((s) => ({ ...s, concluding: true })),
      onQuestionFinal: (next) => {
        setActiveQuestion(next);
        setStream(IDLE_STREAM);
        void queryClient.invalidateQueries({ queryKey: ['user-book', id, 'interview'] });
      },
      onDone: (workflowStatus) => {
        setStream(IDLE_STREAM);
        if (workflowStatus === 'interviewing') {
          void interview.refetch();
        } else {
          // Interview finished — let the workflow gate navigate to the next step.
          void queryClient.invalidateQueries({ queryKey: ['user-book', id] });
        }
      },
      onError: (message) => {
        setStream(IDLE_STREAM);
        setStreamError(message);
        void interview.refetch();
      },
    }),
    onError: (error) => {
      setStream(IDLE_STREAM);
      setStreamError(error instanceof ApiError ? error.message : '提交失败，请稍后再试。');
      void interview.refetch();
    },
  });

  const submit = (choice: { optionId?: string; text?: string }) => {
    if (!question || answer.isPending) return;
    const answerLabel = choice.optionId
      ? (question.options.find((option) => option.id === choice.optionId)?.label ?? choice.optionId)
      : (choice.text ?? '');
    setLocalHistory((history) => [
      ...history.filter((turn) => turn.questionId !== question.id),
      { questionId: question.id, question: question.prompt, answer: answerLabel },
    ]);
    setStreamError(null);
    setText('');
    setTurnSeq((n) => n + 1);
    setStream({ ...IDLE_STREAM, active: true, sufficiency: question.sufficiency });
    answer.mutate({ questionId: question.id, ...choice });
  };

  if (gate.query.isPending || !gate.active) {
    return <WorkflowFallback title="正在找到这本书" detail="正在恢复你上次离开的访谈位置。" />;
  }
  if (gate.query.isError) {
    return <WorkflowFallback title="这本书暂时打不开" detail={gate.query.error.message} retry={() => void gate.query.refetch()} />;
  }
  const book = gate.query.data.sharedBook;
  if (interview.isPending) {
    return <WorkflowPage book={book} kicker="A CONVERSATION · 本书访谈" title="先聊几句" hideHeader><WorkflowMessage title="正在恢复访谈">答案和当前问题正在从服务端读取。</WorkflowMessage></WorkflowPage>;
  }
  if (interview.isError) {
    return <WorkflowPage book={book} kicker="A CONVERSATION · 本书访谈" title="先聊几句" hideHeader><WorkflowMessage title="访谈暂时没有打开" action={<button className="button button-ghost" type="button" onClick={() => void interview.refetch()}>重新读取</button>}>{interview.error.message}</WorkflowMessage></WorkflowPage>;
  }
  const snapshot = interview.data;

  const streaming = stream.active;
  const concludingView = stream.concluding || snapshot.status === 'completing';
  const failedView = snapshot.status === 'failed' && !streaming;
  const interactive = !streaming && snapshot.status === 'asking' && !!question;

  // A single turn draws its text from the live stream while streaming, then from the
  // authoritative question once it settles — the same markup, so nothing re-animates.
  const turnAck = streaming ? stream.ack : (question?.acknowledgment ?? '');
  const turnPrompt = streaming ? stream.prompt : (question?.prompt ?? '');
  // The hint streams in right after the prompt and before the options (prototype screen 05),
  // so it reveals in place rather than popping in after everything settles.
  const turnHint = streaming ? stream.hint : (question?.hint ?? '');
  const turnOptions = streaming ? stream.options : (question?.options ?? []);
  const sufficiency = streaming ? stream.sufficiency : (question?.sufficiency ?? null);
  const thinking = streaming && !stream.concluding && !turnPrompt;

  // History prefers the local record for turns answered this session (instant, no refetch flash),
  // keeping the server snapshot for turns from a resumed session it doesn't yet cover.
  const localByQuestion = new Map(localHistory.map((turn) => [turn.questionId, turn]));
  const covered = new Set<string>();
  const history = snapshot.history.map((item) => {
    if (item.questionId) covered.add(item.questionId);
    return (item.questionId && localByQuestion.get(item.questionId)) || item;
  });
  for (const turn of localHistory) {
    if (!covered.has(turn.questionId)) history.push(turn);
  }

  return (
    <WorkflowPage book={book} kicker="A CONVERSATION · 本书访谈" title="先聊几句" hideHeader>
      <section className="interview">
        <div className="interview-rule" aria-hidden="true"><i style={{ width: `${clampPercent(sufficiency)}%` }} /></div>
        <div className="interview-head">
          <span className="interview-eyebrow"><i aria-hidden="true" />认识你 · A Conversation</span>
          <span className="interview-suff">信息充足度 {sufficiency === null ? '—' : `${clampPercent(sufficiency)}%`}</span>
        </div>

        {history.length ? (
          <div className="interview-history" aria-label="之前的回答">
            {history.map((item, index) => (
              <div className="interview-hist" key={item.questionId ?? `${index}:${item.answer}`}>
                <p>{item.question}</p>
                <div><span><i aria-hidden="true">——</i>{item.answer}</span></div>
              </div>
            ))}
          </div>
        ) : null}

        {failedView ? (
          <WorkflowMessage
            title="整理暂时停住了"
            action={<button className="button button-primary" type="button" disabled={interview.isFetching} onClick={() => void interview.refetch()}>{interview.isFetching ? '正在重新读取…' : '重新读取'}</button>}
          >{snapshot.errorSummary || '已经提交的回答都还在，可以从这里继续。'}</WorkflowMessage>
        ) : concludingView ? (
          <div className="interview-turn" key="concluding">
            <h2 className="interview-prompt"><Typeset text="好，我心里有数了——就问到这里。" /></h2>
            <p className="interview-sub">再问下去就是负担了。接下来交给我。</p>
            <div className="interview-generating">
              <div className="workflow-typing" aria-hidden="true"><span /><span /><span /></div>
              <span>正在生成读前简报 · Brief</span>
            </div>
          </div>
        ) : (
          <div className="interview-turn" key={`turn-${turnSeq}`}>
            {turnAck ? <p className="interview-ack"><Typeset text={turnAck} /></p> : null}
            {thinking ? <div className="workflow-typing interview-thinking" aria-label="正在输入…"><span /><span /><span /></div> : null}
            {turnPrompt ? <h2 className="interview-prompt"><Typeset text={turnPrompt} /></h2> : null}
            {turnHint ? <p className="interview-sub interview-hint">{turnHint}</p> : null}
            {turnOptions.length ? (
              <div className="interview-options">
                {turnOptions.map((option, index) => (
                  <button
                    key={option.id}
                    type="button"
                    className="interview-option"
                    style={{ ['--i']: index } as CSSProperties}
                    disabled={!interactive || answer.isPending}
                    onClick={() => submit({ optionId: option.id })}
                  ><span aria-hidden="true">↳</span>{option.label}</button>
                ))}
              </div>
            ) : null}
            {interactive ? (
              <div className="interview-compose">
                <span aria-hidden="true">↳</span>
                <textarea
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      if (text.trim()) submit({ text: text.trim() });
                    }
                  }}
                  placeholder="或者，自己说两句…"
                  rows={1}
                  aria-label="自己补充"
                />
                <button
                  type="button"
                  className="interview-send"
                  aria-label="发送"
                  data-active={text.trim() ? true : undefined}
                  disabled={!text.trim() || answer.isPending}
                  onClick={() => submit({ text: text.trim() })}
                >→</button>
              </div>
            ) : null}
            {streamError ? <div className="form-error" role="alert">{streamError}</div> : null}
          </div>
        )}

        {!concludingView && !failedView ? (
          <p className="interview-note">问几个由我判断——信息够了，我就不再多问。</p>
        ) : null}
      </section>
    </WorkflowPage>
  );
}
