import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { bookAssetBaseUrl } from '../library/api';
import { prepareStandaloneContent } from '../reader/content';
import { NotePopover, popoverPlacement } from '../reader/NotePopover';
import type { ActivePopover } from '../reader/NotePopover';
import {
  adoptTrial,
  ApiError,
  getTrial,
  markTrialSampleViewed,
  retryTrial,
  submitTrialFeedback,
} from './api';
import type { TrialSample, TrialSnapshot } from './api';
import {
  AdjustmentForm,
  AssistanceContent,
  BackToShelf,
  WorkflowFallback,
  WorkflowMessage,
  WorkflowPage,
} from './components';
import { userBookQueryKeys } from './queryKeys';
import { useWorkflowGate } from './useWorkflowGate';

interface TrialFeedbackCommand {
  trialRevisionId: string;
  feedback: string;
  idempotencyKey: string;
}

export function TrialPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const gate = useWorkflowGate(id, ['trial_generating', 'trial_generation_failed', 'trial_review']);
  const currentTrialRevisionId = gate.query.data?.currentTrialRevisionId ?? '';
  const trial = useQuery({
    queryKey: userBookQueryKeys.trial(id, currentTrialRevisionId),
    queryFn: () => getTrial(id, currentTrialRevisionId),
    enabled: gate.active && Boolean(currentTrialRevisionId),
    refetchInterval: (current) => current.state.data?.status === 'generating' ? 1800 : false,
  });
  const [sampleIndex, setSampleIndex] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [popover, setPopover] = useState<ActivePopover | null>(null);
  const viewedAttempts = useRef(new Set<string>());
  const feedbackCommand = useRef<TrialFeedbackCommand | null>(null);
  const resyncOnConflict = async (error: Error) => {
    if (error instanceof ApiError && error.status === 409) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(id) }),
        queryClient.invalidateQueries({ queryKey: userBookQueryKeys.trials(id) }),
      ]);
    }
  };

  const saveSnapshot = (snapshot: TrialSnapshot) => {
    queryClient.setQueryData(userBookQueryKeys.trial(id, snapshot.revisionId), snapshot);
  };
  const viewed = useMutation({
    mutationFn: (sample: TrialSample) => markTrialSampleViewed(id, trial.data?.revisionId ?? '', sample.id),
    onSuccess: saveSnapshot,
    onError: resyncOnConflict,
  });
  const retry = useMutation({
    mutationFn: () => retryTrial(id),
    onSuccess: async (snapshot) => {
      saveSnapshot(snapshot);
      await queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(id) });
    },
    onError: resyncOnConflict,
  });
  const revise = useMutation<Awaited<ReturnType<typeof submitTrialFeedback>>, Error, TrialFeedbackCommand>({
    mutationFn: (command) => submitTrialFeedback(
      id,
      command.trialRevisionId,
      command.feedback,
      command.idempotencyKey,
    ),
    onSuccess: async (strategy) => {
      feedbackCommand.current = null;
      queryClient.setQueryData(userBookQueryKeys.strategy(id, strategy.draftId), strategy);
      await queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(id) });
      navigate(`/user-books/${encodeURIComponent(id)}/strategy`, { replace: true });
    },
    onError: resyncOnConflict,
  });
  const submitFeedback = () => {
    if (!trial.data) return;
    const trimmedFeedback = feedback.trim();
    const previous = feedbackCommand.current;
    const command = previous?.trialRevisionId === trial.data.revisionId && previous.feedback === trimmedFeedback
      ? previous
      : {
          trialRevisionId: trial.data.revisionId,
          feedback: trimmedFeedback,
          idempotencyKey: crypto.randomUUID(),
        };
    feedbackCommand.current = command;
    revise.mutate(command);
  };
  const adopt = useMutation({
    mutationFn: () => {
      if (!trial.data) throw new Error('当前试读版本已经失效。');
      return adoptTrial(id, trial.data.revisionId, trial.data.draftId);
    },
    onSuccess: (userBook) => {
      queryClient.setQueryData(userBookQueryKeys.detail(id), userBook);
      navigate(`/user-books/${encodeURIComponent(id)}/read`, { replace: true });
    },
    onError: resyncOnConflict,
  });

  const samples = useMemo(
    () => [...(trial.data?.samples ?? [])].sort((left, right) => left.ordinal - right.ordinal),
    [trial.data?.samples],
  );
  const current = samples[sampleIndex];
  const currentHtml = useMemo(
    () => current ? prepareStandaloneContent(
      current.originalHtml,
      bookAssetBaseUrl(gate.query.data?.sharedBook.id ?? ''),
      current.tailoredContent?.annotations ?? [],
    ) : '',
    [current, gate.query.data?.sharedBook.id],
  );
  // Flat id → content lookup so a click on an in-text 裁读注 anchor opens its note as a
  // popover — the same interaction as the reader — instead of scrolling to a list.
  const annotationContentById = useMemo(() => {
    const map = new Map<string, string>();
    for (const annotation of current?.tailoredContent?.annotations ?? []) map.set(annotation.id, annotation.content);
    return map;
  }, [current]);

  useEffect(() => {
    setSampleIndex(0);
    viewedAttempts.current.clear();
  }, [trial.data?.revision]);

  useEffect(() => {
    if (!trial.data || trial.data.status !== 'ready' || !current || current.status !== 'ready' || current.viewedAt) return;
    const key = `${trial.data.revision}:${current.id}`;
    if (viewedAttempts.current.has(key)) return;
    viewedAttempts.current.add(key);
    viewed.mutate(current);
  }, [current, trial.data?.revision, trial.data?.status]);

  // The fixed-position popover is anchored to an in-text mark, so any scroll/resize would
  // leave it detached — close it. Switching samples re-renders the passage under it too.
  useEffect(() => setPopover(null), [sampleIndex]);
  useEffect(() => {
    if (!popover) return;
    const close = () => setPopover(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setPopover(null); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [popover]);

  if (gate.query.isPending || !gate.active) return <WorkflowFallback title="正在打开试读" detail="正在确认当前试读版本。" />;
  if (gate.query.isError) return <WorkflowFallback title="试读暂时打不开" detail={gate.query.error.message} retry={() => void gate.query.refetch()} />;
  const book = gate.query.data.sharedBook;
  if (trial.isPending) return <WorkflowPage book={book} kicker="TRIAL SAMPLES · 三个试读" title="先用三段原文试一试"><WorkflowMessage title="正在读取试读状态">当前 revision 正在从服务端恢复。</WorkflowMessage></WorkflowPage>;
  if (trial.isError) return <WorkflowPage book={book} kicker="TRIAL SAMPLES · 三个试读" title="先用三段原文试一试"><WorkflowMessage title="暂时读不到试读" action={<button className="button button-ghost" type="button" onClick={() => void trial.refetch()}>重新读取</button>}>{trial.error.message}</WorkflowMessage></WorkflowPage>;
  const snapshot = trial.data;
  const mutationError = retry.error?.message ?? revise.error?.message ?? adopt.error?.message;

  return (
    <WorkflowPage book={book} kicker="TRIAL SAMPLES · 三个试读" title="先用三段原文试一试">
      {snapshot.status === 'generating' ? (
        <section className="trial-generating">
          <WorkflowMessage title="正在生成三个试读片段">
            三个片段会全部成功后一起出现。现在不会展示部分结果，也不会让旧版本混进来。
          </WorkflowMessage>
          <div className="trial-generation-progress">
            <span>已完成 {snapshot.progress.completed} / {snapshot.progress.total}</span>
            <i><span style={{ width: `${(snapshot.progress.completed / snapshot.progress.total) * 100}%` }} /></i>
          </div>
          <BackToShelf />
        </section>
      ) : snapshot.status === 'failed' ? (
        <WorkflowMessage
          title="这一轮试读没有完整生成"
          action={<div className="workflow-actions"><button className="button button-primary" type="button" disabled={retry.isPending} onClick={() => retry.mutate()}>{retry.isPending ? '正在重试整轮…' : '重试整轮生成'}</button><BackToShelf /></div>}
        >{snapshot.errorSummary || '三个片段不会部分发布。技术重试不会占用你的调整次数。'}</WorkflowMessage>
      ) : current ? (
        <div className="trial-review">
          <header className="trial-review-header">
            <div><span>试读 {sampleIndex + 1} / {samples.length}</span><strong>{current.chapterPath.join(' › ') || '章节位置未详'}</strong></div>
            <div className="trial-dots" aria-label={`试读 ${sampleIndex + 1} / ${samples.length}`}>
              {samples.map((sample, index) => <i key={sample.id} data-active={index === sampleIndex} data-viewed={Boolean(sample.viewedAt)} />)}
            </div>
          </header>

          <article
            className="trial-sample"
            onClick={(event) => {
              const anchor = (event.target as HTMLElement).closest<HTMLElement>('[data-annotation-id]');
              if (!anchor?.dataset.annotationId) return;
              const content = annotationContentById.get(anchor.dataset.annotationId);
              if (!content) return;
              setPopover({ body: { kind: 'tailored', content }, ...popoverPlacement(anchor.getBoundingClientRect()) });
            }}
          >
            {current.tailoredContent?.guide ? (
              <section className="tailored-guide">
                <span>GUIDE · 导读</span>
                <AssistanceContent content={current.tailoredContent.guide} />
              </section>
            ) : null}
            <div className="trial-original rt-reader-content" dangerouslySetInnerHTML={{ __html: currentHtml }} />
            {current.tailoredContent?.afterReading ? (
              <section className="tailored-after-reading">
                <span>AFTER READING · 节后助读</span>
                <AssistanceContent content={current.tailoredContent.afterReading} />
              </section>
            ) : null}
          </article>

          {viewed.isError && !current.viewedAt ? (
            <div className="form-error" role="alert">
              查看记录没有保存。<button type="button" onClick={() => { viewedAttempts.current.delete(`${snapshot.revision}:${current.id}`); viewed.mutate(current); }}>重新记录</button>
            </div>
          ) : null}

          <nav className="trial-navigation" aria-label="试读片段导航">
            <button className="button button-ghost" type="button" disabled={sampleIndex === 0} onClick={() => setSampleIndex((value) => Math.max(0, value - 1))}>‹ 上一个片段</button>
            <button className="button button-ghost" type="button" disabled={sampleIndex >= samples.length - 1} onClick={() => setSampleIndex((value) => Math.min(samples.length - 1, value + 1))}>下一个片段 ›</button>
          </nav>

          {snapshot.canAdjust ? (
            <AdjustmentForm
              value={feedback}
              onChange={setFeedback}
              onSubmit={submitFeedback}
              pending={revise.isPending}
              label={`试读不对味？反馈会回到处理方式 · 还可调整 ${Math.max(0, snapshot.adjustmentLimit - snapshot.adjustmentCount)} 次`}
              placeholder="比如：导读再短一点；术语解释不要太浅；注释只留真正影响理解的地方。"
            />
          ) : <div className="adjustment-limit">已经达到 {snapshot.adjustmentLimit} 次调整上限。你仍可查看三个片段并采用当前处理方式。</div>}
          {mutationError ? <div className="form-error" role="alert">{mutationError}</div> : null}
          <div className="workflow-actions workflow-actions-final">
            <button className="button button-primary" type="button" disabled={adopt.isPending} onClick={() => adopt.mutate()}>
              {adopt.isPending ? '正在采用…' : '采用这个处理方式并开始阅读'}
            </button>
            <BackToShelf />
          </div>
          <NotePopover popover={popover} close={() => setPopover(null)} />
        </div>
      ) : <WorkflowMessage title="试读结果不完整">当前 revision 没有返回完整的三个片段，请重新读取。</WorkflowMessage>}
    </WorkflowPage>
  );
}
