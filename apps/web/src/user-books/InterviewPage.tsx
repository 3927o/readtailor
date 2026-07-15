import { useEffect, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router';
import { WorkflowMessage, WorkflowPage } from './components';
import { ProgressiveStrategyView } from './ProgressiveStrategyView';
import { useInterviewController, type InterviewChoice } from './useInterviewController';
import { useReadingSetupWorkflow } from './useReadingSetupWorkflow';

// Live state accumulated from the SSE turn (§4.3): the acknowledgment and prompt arrive one
// fragment at a time, options stagger in, and the agent reports its own information
// sufficiency. The interaction form follows the prototype's interview screen
// (design/prototypes/readtailor-mvp.dc.html, screen 05): a conversation that materializes
// token by token, where the agent decides when it has heard enough.
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
  const { userBook } = useReadingSetupWorkflow();
  const shouldStart = userBook.workflowStatus === 'on_shelf';
  const controller = useInterviewController({ userBookId: id, shouldStart });
  const [text, setText] = useState('');

  useEffect(() => {
    setText('');
  }, [controller.question?.id]);

  const submit = (choice: InterviewChoice) => {
    if (controller.submit(choice)) setText('');
  };

  const book = userBook.sharedBook;
  if (shouldStart) {
    return controller.startError
      ? <WorkflowPage book={book} kicker="A CONVERSATION · 本书访谈" title="先聊几句" hideHeader><WorkflowMessage title="访谈暂时没有开始" action={<button className="button button-ghost" type="button" onClick={controller.retryStart}>重新开始</button>}>{controller.startError.message}</WorkflowMessage></WorkflowPage>
      : <WorkflowPage book={book} kicker="A CONVERSATION · 本书访谈" title="先聊几句" hideHeader><WorkflowMessage title="正在准备第一问">我正在结合这本书和你的长期画像整理开场问题。</WorkflowMessage></WorkflowPage>;
  }
  if (controller.loading) {
    return <WorkflowPage book={book} kicker="A CONVERSATION · 本书访谈" title="先聊几句" hideHeader><WorkflowMessage title="正在恢复访谈">答案和当前问题正在从服务端读取。</WorkflowMessage></WorkflowPage>;
  }
  if (controller.loadError) {
    return <WorkflowPage book={book} kicker="A CONVERSATION · 本书访谈" title="先聊几句" hideHeader><WorkflowMessage title="访谈暂时没有打开" action={<button className="button button-ghost" type="button" onClick={controller.retryLoad}>重新读取</button>}>{controller.loadError.message}</WorkflowMessage></WorkflowPage>;
  }
  const snapshot = controller.snapshot!;
  const stream = controller.stream;

  return (
    <WorkflowPage book={book} kicker="A CONVERSATION · 本书访谈" title="先聊几句" hideHeader>
      <section className="interview">
        <div className="interview-rule" aria-hidden="true"><i style={{ width: `${clampPercent(controller.sufficiency)}%` }} /></div>
        <div className="interview-head">
          <span className="interview-eyebrow"><i aria-hidden="true" />认识你 · A Conversation</span>
          <span className="interview-suff">信息充足度 {controller.sufficiency === null ? '—' : `${clampPercent(controller.sufficiency)}%`}</span>
        </div>

        {!controller.draftView && controller.history.length ? (
          <div className="interview-history" aria-label="之前的回答">
            {controller.history.map((item, index) => (
              <div className="interview-hist" key={item.questionId ?? `${index}:${item.answer}`}>
                <p>{item.question}</p>
                <div><span><i aria-hidden="true">——</i>{item.answer}</span></div>
              </div>
            ))}
          </div>
        ) : null}

        {controller.failedView ? (
          <WorkflowMessage
            title="整理暂时停住了"
            action={<button className="button button-primary" type="button" disabled={controller.isFetching} onClick={controller.retryLoad}>{controller.isFetching ? '正在重新读取…' : '重新读取'}</button>}
          >{stream.error || snapshot.errorSummary || '已经提交的回答都还在，可以从这里继续。'}</WorkflowMessage>
        ) : controller.draftView ? (
          <ProgressiveStrategyView model={{
            mode: stream.finalStrategy
              ? 'committed'
              : stream.mode === 'error'
                ? 'failed'
                : stream.mode === 'recovering' || snapshot.status === 'generating'
                  ? 'recovering'
                  : 'streaming',
            source: 'interview',
            briefing: stream.briefing,
            strategySummary: stream.strategySummary,
            nodes: stream.nodes,
            ...(stream.finalStrategy ? { draftVersion: stream.finalStrategy.draftVersion } : {}),
            ...(stream.error ? { error: stream.error } : {}),
          }} />
        ) : (
          <div className="interview-turn" key={`turn-${controller.turnSeq}`}>
            {controller.turnAck ? <p className="interview-ack"><Typeset text={controller.turnAck} /></p> : null}
            {controller.thinking ? <div className="workflow-typing interview-thinking" aria-label="正在输入…"><span /><span /><span /></div> : null}
            {controller.turnPrompt ? <h2 className="interview-prompt"><Typeset text={controller.turnPrompt} /></h2> : null}
            {controller.turnHint ? <p className="interview-sub interview-hint">{controller.turnHint}</p> : null}
            {controller.turnOptions.length ? (
              <div className="interview-options">
                {controller.turnOptions.map((option, index) => (
                  <button
                    key={option.id}
                    type="button"
                    className="interview-option"
                    style={{ ['--i']: index } as CSSProperties}
                    disabled={!controller.interactive || controller.answerPending}
                    onClick={() => submit({ optionId: option.id })}
                  ><span aria-hidden="true">↳</span>{option.label}</button>
                ))}
              </div>
            ) : null}
            {controller.interactive ? (
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
                  disabled={!text.trim() || controller.answerPending}
                  onClick={() => submit({ text: text.trim() })}
                >→</button>
              </div>
            ) : null}
            {controller.streamError ? <div className="form-error" role="alert">{controller.streamError}</div> : null}
          </div>
        )}

        {!controller.draftView && !controller.failedView ? (
          <p className="interview-note">问几个由我判断——信息够了，我就不再多问。</p>
        ) : null}
      </section>
    </WorkflowPage>
  );
}
