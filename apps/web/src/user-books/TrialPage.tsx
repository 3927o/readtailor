import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { nearestReaderAnchor } from '../reader/content';
import { NotePopover, popoverPlacement } from '../reader/NotePopover';
import type { ActivePopover } from '../reader/NotePopover';
import {
  browserReaderAnchorProbe,
  useReaderLayoutAnchor,
} from '../reader/readerLayoutAnchor';
import type { ReaderLogicalPosition } from '../reader/readerLayoutAnchor';
import type { TailoredContent, TrialSample } from './api/trial';
import {
  AdjustmentForm,
  BackToShelf,
  WorkflowMessage,
  WorkflowPage,
} from './components';
import { ProgressiveTrialView } from './ProgressiveTrialView';
import { useReadingSetupWorkflow } from './useReadingSetupWorkflow';
import { useTrialReviewController } from './useTrialReviewController';

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
  const { userBook } = useReadingSetupWorkflow();
  const [sampleIndex, setSampleIndex] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [popover, setPopover] = useState<ActivePopover | null>(null);
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
  };
  const activeOrdinal = Math.max(1, Math.min(3, sampleIndex + 1)) as 1 | 2 | 3;
  const controller = useTrialReviewController({
    userBookId: id,
    userBook,
    activeOrdinal,
    onRevisionCompleted: () => setFeedback(''),
    onRecoverableFeedback: setFeedback,
    onTrialReset: resetTrialView,
  });

  const samples = controller.samples;
  const current = controller.current;
  const currentTailoredContent = readyTailoredContent(current);
  const enhancementVersion = trialEnhancementVersion(current);
  const revisionId = controller.snapshot?.revisionId ?? null;
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
  }, [controller.snapshot?.revisionId]);

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

  const book = userBook.sharedBook;
  if (controller.loading) return <WorkflowPage book={book} kicker="TRIAL SAMPLES · 三个试读" title="先用三段原文试一试"><WorkflowMessage title="正在读取试读状态">当前 revision 正在从服务端恢复。</WorkflowMessage></WorkflowPage>;
  if (controller.loadError) return <WorkflowPage book={book} kicker="TRIAL SAMPLES · 三个试读" title="先用三段原文试一试"><WorkflowMessage title="暂时读不到试读" action={<button className="button button-ghost" type="button" onClick={controller.retryLoad}>重新读取</button>}>{controller.loadError.message}</WorkflowMessage></WorkflowPage>;
  const snapshot = controller.snapshot!;

  return (
    <WorkflowPage book={book} kicker="TRIAL SAMPLES · 三个试读" title="先用三段原文试一试">
      {samples.length > 0 ? (
        <section className={snapshot.status === 'ready' ? 'trial-review' : 'trial-generating'}>
          {controller.revisionActive ? (
            <div className="workflow-callout" role="status">
              正在根据反馈重新起草处理方式，当前样章仍可查看。
            </div>
          ) : null}
          <ProgressiveTrialView
            model={controller.trialModel!}
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
              {controller.retryError ? <div className="form-error" role="alert">{controller.retryError.message}</div> : null}
              <div className="workflow-actions workflow-actions-final">
                <button className="button button-primary" type="button" disabled={controller.retryPending} onClick={controller.retryTrial}>
                  {controller.retryPending ? '正在重试整轮…' : '重试整轮生成'}
                </button>
                <BackToShelf />
              </div>
            </>
          ) : (
            <>
              {controller.viewedError && current && !current.viewedAt ? (
                <div className="form-error" role="alert">
                  查看记录没有保存。<button type="button" onClick={controller.retryViewed}>重新记录</button>
                </div>
              ) : null}
              {snapshot.canAdjust ? (
                <AdjustmentForm
                  value={feedback}
                  onChange={setFeedback}
                  onSubmit={() => controller.submitFeedback(feedback)}
                  pending={controller.feedbackPending}
                  disabled={controller.revisionActive}
                  {...(controller.revisionFailed ? { submitLabel: '重新提交反馈' } : {})}
                  label={`试读不对味？反馈会回到处理方式 · 还可调整 ${Math.max(0, snapshot.adjustmentLimit - snapshot.adjustmentCount)} 次`}
                  placeholder="比如：导读再短一点；术语解释不要太浅；注释只留真正影响理解的地方。"
                />
              ) : <div className="adjustment-limit">已经达到 {snapshot.adjustmentLimit} 次调整上限。你仍可查看三个片段并采用当前处理方式。</div>}
              {controller.mutationError ? <div className="form-error" role="alert">{controller.mutationError}</div> : null}
              <div className="workflow-actions workflow-actions-final">
                <button
                  className="button button-primary"
                  type="button"
                  disabled={controller.revisionActive || controller.adoptPending || !snapshot.canAdopt}
                  onClick={controller.adopt}
                >
                  {controller.adoptPending ? '正在采用…' : '采用这个处理方式并开始阅读'}
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
