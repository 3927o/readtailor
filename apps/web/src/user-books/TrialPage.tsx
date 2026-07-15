import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { bookAssetBaseUrl } from '../library/api';
import { nearestReaderAnchor } from '../reader/content';
import { NotePopover, popoverPlacement } from '../reader/NotePopover';
import type { ActivePopover } from '../reader/NotePopover';
import {
  browserReaderAnchorProbe,
  useReaderLayoutAnchor,
} from '../reader/readerLayoutAnchor';
import type { ReaderLogicalPosition } from '../reader/readerLayoutAnchor';
import {
  adoptTrial,
  ApiError,
  getStrategy,
  getTrial,
  markTrialSampleViewed,
  retryTrial,
} from './api';
import type { TailoredContent, TrialSample, TrialSnapshot, UserBookDetail } from './api';
import {
  AdjustmentForm,
  BackToShelf,
  WorkflowFallback,
  WorkflowMessage,
  WorkflowPage,
} from './components';
import { userBookQueryKeys } from './queryKeys';
import { ProgressiveStrategyView } from './ProgressiveStrategyView';
import { ProgressiveTrialView } from './ProgressiveTrialView';
import { useStrategyRevisionFlow } from './useStrategyRevisionFlow';
import { useWorkflowGate } from './useWorkflowGate';

const TRIAL_READING_ANCHOR_TOP = 96;

function readyTailoredContent(sample: TrialSample | undefined): TailoredContent | null {
  return sample?.status === 'ready' && sample.tailoredContent ? sample.tailoredContent : null;
}

function trialLayoutPosition(root: HTMLElement): ReaderLogicalPosition | null {
  const original = root.querySelector<HTMLElement>('.progressive-trial [role="tabpanel"] .reader-original');
  const node = original?.closest<HTMLElement>('[data-section-id][data-segment]');
  const sectionId = node?.dataset.sectionId;
  const segment = Number(node?.dataset.segment ?? Number.NaN);
  if (!original || !sectionId || !Number.isFinite(segment)) return null;
  const rect = original.getBoundingClientRect();
  const anchor = nearestReaderAnchor(
    [original],
    rect.width > 0 ? rect.left + rect.width / 2 : window.innerWidth / 2,
    Math.max(1, Math.min(window.innerHeight - 1, TRIAL_READING_ANCHOR_TOP)),
    browserReaderAnchorProbe(),
  );
  return anchor ? {
    sectionId,
    segment,
    blockIndex: anchor.blockIndex,
    offset: anchor.offset,
  } : null;
}

function trialEnhancementVersion(sample: TrialSample | undefined): string {
  const content = readyTailoredContent(sample);
  return [
    sample?.id ?? 'none',
    sample?.status ?? 'missing',
    content?.guide ?? '',
    content?.annotations.map((annotation) => [
      annotation.id,
      annotation.range.start.blockIndex,
      annotation.range.start.offset,
      annotation.range.end.blockIndex,
      annotation.range.end.offset,
      annotation.content,
    ].join(':')).join('|') ?? '',
    content?.afterReading ?? '',
  ].join('§');
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
    refetchInterval: (current) => current.state.data?.status === 'generating' ? 1000 : false,
  });
  const [sampleIndex, setSampleIndex] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [popover, setPopover] = useState<ActivePopover | null>(null);
  const viewedAttempts = useRef(new Set<string>());
  const layoutRoot = useRef<HTMLElement | null>(null);
  const suppressLayoutAnchor = useRef(false);
  const renderedRevisionId = useRef<string | null>(null);
  if (layoutRoot.current === null && typeof document !== 'undefined') {
    layoutRoot.current = (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
  }
  const resetTrialView = () => {
    suppressLayoutAnchor.current = true;
    setSampleIndex(0);
    setPopover(null);
    viewedAttempts.current.clear();
  };
  const baseDraftId = trial.data?.draftId ?? '';
  const baseStrategy = useQuery({
    queryKey: userBookQueryKeys.strategy(id, baseDraftId),
    queryFn: () => getStrategy(id, baseDraftId),
    enabled: gate.active && Boolean(baseDraftId),
  });
  const revision = useStrategyRevisionFlow({
    userBookId: id,
    source: 'trial_feedback',
    baseDraftId,
    baseTrialRevisionId: currentTrialRevisionId || null,
    enabled: gate.active && Boolean(baseDraftId && currentTrialRevisionId),
    onCompleted: () => setFeedback(''),
    onRecoverableFeedback: setFeedback,
  });
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
      resetTrialView();
      saveSnapshot(snapshot);
      queryClient.setQueryData<UserBookDetail>(userBookQueryKeys.detail(id), (current) => current ? {
        ...current,
        workflowStatus: snapshot.status === 'failed'
          ? 'trial_generation_failed'
          : snapshot.status === 'ready'
            ? 'trial_review'
            : 'trial_generating',
        currentStrategyDraftVersionId: snapshot.draftId,
        currentTrialRevisionId: snapshot.revisionId,
      } : current);
      await queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(id) });
    },
    onError: resyncOnConflict,
  });
  const submitFeedback = () => {
    if (!baseStrategy.data) return;
    revision.submit(feedback);
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
  const currentTailoredContent = readyTailoredContent(current);
  const enhancementVersion = trialEnhancementVersion(current);
  const revisionId = trial.data?.revisionId ?? null;
  if (
    revisionId
    && renderedRevisionId.current
    && renderedRevisionId.current !== revisionId
  ) {
    suppressLayoutAnchor.current = true;
  }
  if (revisionId) renderedRevisionId.current = revisionId;
  useReaderLayoutAnchor({
    root: layoutRoot,
    version: enhancementVersion,
    getPosition: () => suppressLayoutAnchor.current || !layoutRoot.current
      ? null
      : trialLayoutPosition(layoutRoot.current),
    getPhase: () => 'normal',
  });
  useLayoutEffect(() => {
    suppressLayoutAnchor.current = false;
  }, [revisionId]);
  // Flat id → content lookup so a click on an in-text 裁读注 anchor opens its note as a
  // popover — the same interaction as the reader — instead of scrolling to a list.
  const annotationContentById = useMemo(() => {
    const map = new Map<string, string>();
    for (const annotation of currentTailoredContent?.annotations ?? []) map.set(annotation.id, annotation.content);
    return map;
  }, [currentTailoredContent]);

  useEffect(() => {
    setSampleIndex(0);
    setPopover(null);
    viewedAttempts.current.clear();
  }, [trial.data?.revisionId]);

  useEffect(() => {
    if (!trial.data || trial.data.status !== 'ready' || !current || current.status !== 'ready' || current.viewedAt) return;
    const key = `${trial.data.revision}:${current.id}`;
    if (viewedAttempts.current.has(key)) return;
    viewedAttempts.current.add(key);
    viewed.mutate(current);
  }, [current, trial.data?.revision, trial.data?.status]);

  // The fixed-position popover is anchored to an in-text mark, so any scroll/resize would
  // leave it detached — close it. Switching samples re-renders the passage under it too.
  useEffect(() => setPopover(null), [sampleIndex, enhancementVersion]);
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
  const mutationError = retry.error?.message
    ?? revision.error
    ?? baseStrategy.error?.message
    ?? adopt.error?.message;
  const activeOrdinal = Math.max(1, Math.min(3, sampleIndex + 1)) as 1 | 2 | 3;

  return (
    <WorkflowPage book={book} kicker="TRIAL SAMPLES · 三个试读" title="先用三段原文试一试">
      {revision.active ? (
        <ProgressiveStrategyView model={{
          mode: revision.state.mode === 'completed'
            ? 'committed'
            : revision.state.mode === 'recovering'
              ? 'recovering'
              : 'streaming',
          source: 'trial_feedback',
          briefing: baseStrategy.data?.readingBriefing ?? {},
          strategySummary: revision.state.strategySummary,
          nodes: revision.state.nodes,
          ...(revision.state.finalStrategy
            ? { draftVersion: revision.state.finalStrategy.draftVersion }
            : {}),
          ...(revision.state.error ? { error: revision.state.error } : {}),
        }} />
      ) : samples.length > 0 ? (
        <section className={snapshot.status === 'ready' ? 'trial-review' : 'trial-generating'}>
          <ProgressiveTrialView
            model={{
              mode: snapshot.status === 'ready' ? 'review' : snapshot.status,
              samples,
              activeOrdinal,
              assetBaseUrl: bookAssetBaseUrl(book.id),
              ...(snapshot.status === 'failed' && snapshot.errorSummary
                ? { error: snapshot.errorSummary }
                : {}),
            }}
            onSelectOrdinal={(ordinal) => setSampleIndex(ordinal - 1)}
            onAnnotationClick={(annotationId, anchor) => {
              const content = annotationContentById.get(annotationId);
              if (!content) return;
              setPopover({
                body: { kind: 'tailored', content },
                ...popoverPlacement(anchor.getBoundingClientRect()),
              });
            }}
          />
          {snapshot.status === 'generating' ? (
            <>
              <div className="trial-generation-progress">
                <span>已完成 {snapshot.progress.completed} / {snapshot.progress.total}</span>
                <i><span style={{ width: `${(snapshot.progress.completed / snapshot.progress.total) * 100}%` }} /></i>
              </div>
              <div className="workflow-actions"><BackToShelf /></div>
            </>
          ) : snapshot.status === 'failed' ? (
            <>
              {retry.error ? <div className="form-error" role="alert">{retry.error.message}</div> : null}
              <div className="workflow-actions workflow-actions-final">
                <button className="button button-primary" type="button" disabled={retry.isPending} onClick={() => retry.mutate()}>
                  {retry.isPending ? '正在重试整轮…' : '重试整轮生成'}
                </button>
                <BackToShelf />
              </div>
            </>
          ) : (
            <>
              {viewed.isError && current && !current.viewedAt ? (
                <div className="form-error" role="alert">
                  查看记录没有保存。<button type="button" onClick={() => { viewedAttempts.current.delete(`${snapshot.revision}:${current.id}`); viewed.mutate(current); }}>重新记录</button>
                </div>
              ) : null}
              {snapshot.canAdjust ? (
                <AdjustmentForm
                  value={feedback}
                  onChange={setFeedback}
                  onSubmit={submitFeedback}
                  pending={revision.pending || baseStrategy.isPending}
                  label={`试读不对味？反馈会回到处理方式 · 还可调整 ${Math.max(0, snapshot.adjustmentLimit - snapshot.adjustmentCount)} 次`}
                  placeholder="比如：导读再短一点；术语解释不要太浅；注释只留真正影响理解的地方。"
                />
              ) : <div className="adjustment-limit">已经达到 {snapshot.adjustmentLimit} 次调整上限。你仍可查看三个片段并采用当前处理方式。</div>}
              {mutationError ? <div className="form-error" role="alert">{mutationError}</div> : null}
              <div className="workflow-actions workflow-actions-final">
                <button
                  className="button button-primary"
                  type="button"
                  disabled={adopt.isPending || !snapshot.allViewed}
                  onClick={() => adopt.mutate()}
                >
                  {adopt.isPending ? '正在采用…' : '采用这个处理方式并开始阅读'}
                </button>
                <BackToShelf />
              </div>
            </>
          )}
          <NotePopover popover={popover} close={() => setPopover(null)} />
        </section>
      ) : <WorkflowMessage title="试读结果不完整">当前 revision 没有返回完整的三个片段，请重新读取。</WorkflowMessage>}
    </WorkflowPage>
  );
}
