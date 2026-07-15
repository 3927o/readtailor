import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import { bookAssetBaseUrl } from '../library/api';
import { getStrategy } from './api';
import {
  AdjustmentForm,
  BackToShelf,
  WorkflowFallback,
  WorkflowMessage,
  WorkflowPage,
} from './components';
import { ProgressiveStrategyView } from './ProgressiveStrategyView';
import { ProgressiveTrialView } from './ProgressiveTrialView';
import { userBookQueryKeys } from './queryKeys';
import { useStrategyRevisionFlow } from './useStrategyRevisionFlow';
import { useTrialSelectionFlow } from './useTrialSelectionFlow';
import { useWorkflowGate } from './useWorkflowGate';

export function StrategyPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const gate = useWorkflowGate(id, ['strategy_review']);
  const currentDraftId = gate.query.data?.currentStrategyDraftVersionId ?? '';
  const strategy = useQuery({
    queryKey: userBookQueryKeys.strategy(id, currentDraftId),
    queryFn: () => getStrategy(id, currentDraftId),
    enabled: gate.active && Boolean(currentDraftId),
  });
  const [feedback, setFeedback] = useState('');
  const revision = useStrategyRevisionFlow({
    userBookId: id,
    source: 'strategy_feedback',
    baseDraftId: currentDraftId,
    baseTrialRevisionId: null,
    enabled: gate.active && Boolean(currentDraftId),
    onCompleted: () => setFeedback(''),
    onRecoverableFeedback: setFeedback,
  });
  const selection = useTrialSelectionFlow({
    userBookId: id,
    draftId: currentDraftId,
    enabled: gate.active && Boolean(currentDraftId),
    onCompleted: () => {
      navigate(`/user-books/${encodeURIComponent(id)}/trial`, { replace: true });
    },
  });
  const submitFeedback = () => {
    revision.submit(feedback);
  };
  const submitApproval = () => {
    selection.submit();
  };

  if (gate.query.isPending || !gate.active) return <WorkflowFallback title="正在打开处理方式" detail="正在确认当前草稿版本。" />;
  if (gate.query.isError) return <WorkflowFallback title="处理方式暂时打不开" detail={gate.query.error.message} retry={() => void gate.query.refetch()} />;
  const book = gate.query.data.sharedBook;
  if (strategy.isPending) return <WorkflowPage book={book} kicker="BEFORE YOU READ · 读前准备" title="读之前，先看地图"><WorkflowMessage title="正在展开读前简报">访谈结果和当前草稿正在读取。</WorkflowMessage></WorkflowPage>;
  if (strategy.isError) return <WorkflowPage book={book} kicker="BEFORE YOU READ · 读前准备" title="读之前，先看地图"><WorkflowMessage title="暂时读不到当前草稿" action={<button className="button button-ghost" type="button" onClick={() => void strategy.refetch()}>重新读取</button>}>{strategy.error.message}</WorkflowMessage></WorkflowPage>;
  const snapshot = strategy.data;
  const mutationError = revision.error ?? selection.error;
  const visibleStrategy = revision.state.finalStrategy ?? snapshot;
  const selectionSamples = selection.state.finalTrial?.samples
    ?? selection.state.slots.flatMap((slot) => slot.sample ? [slot.sample] : []);

  return (
    <WorkflowPage book={book} kicker="BEFORE YOU READ · 读前准备" title="读之前，先看地图">
      <div className="strategy-review">
        {selection.active ? <ProgressiveTrialView
          model={{
            mode: selection.state.mode === 'recovering'
              ? 'recovering'
              : selection.state.mode === 'completed'
                ? 'generating'
                : 'selecting',
            samples: selectionSamples,
            activeOrdinal: selection.state.activeOrdinal,
            assetBaseUrl: bookAssetBaseUrl(book.id),
          }}
          onSelectOrdinal={selection.selectOrdinal}
        /> : <ProgressiveStrategyView model={revision.active ? {
          mode: revision.state.mode === 'completed'
            ? 'committed'
            : revision.state.mode === 'recovering'
              ? 'recovering'
              : 'streaming',
          source: 'strategy_feedback',
          briefing: snapshot.readingBriefing,
          strategySummary: revision.state.strategySummary,
          nodes: revision.state.nodes,
          ...(revision.state.finalStrategy
            ? { draftVersion: revision.state.finalStrategy.draftVersion }
            : {}),
          ...(revision.state.error ? { error: revision.state.error } : {}),
        } : {
          mode: 'committed',
          source: 'interview',
          briefing: visibleStrategy.readingBriefing,
          strategySummary: visibleStrategy.userFacingSummary,
          nodes: visibleStrategy.trialCandidatePreviews,
          draftVersion: visibleStrategy.draftVersion,
        }} />}
        {selection.active ? (
          <div className="workflow-actions workflow-actions-final"><BackToShelf /></div>
        ) : (
          <>
            {snapshot.canAdjust ? (
              <AdjustmentForm
                value={feedback}
                onChange={setFeedback}
                onSubmit={submitFeedback}
                pending={revision.active || revision.pending}
                label={`有哪里不合适？还可以调整 ${Math.max(0, snapshot.adjustmentLimit - snapshot.adjustmentCount)} 次`}
                placeholder="比如：导读再短一点；术语保留原文；不要解释已经熟悉的背景。"
              />
            ) : <div className="adjustment-limit">已经达到 {snapshot.adjustmentLimit} 次调整上限。当前草稿仍可以确认并生成最后一轮试读。</div>}
            {mutationError ? <div className="form-error" role="alert">{mutationError}</div> : null}
            <div className="workflow-actions workflow-actions-final">
              <button
                className="button button-primary"
                type="button"
                disabled={selection.pending || revision.active}
                onClick={submitApproval}
              >
                {selection.pending ? '正在创建试读…' : '处理方式没问题，生成试读'}
              </button>
              <BackToShelf />
            </div>
          </>
        )}
      </div>
    </WorkflowPage>
  );
}
