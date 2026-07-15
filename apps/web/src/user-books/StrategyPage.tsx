import { useState } from 'react';
import { useParams } from 'react-router';
import {
  AdjustmentForm,
  BackToShelf,
  WorkflowMessage,
  WorkflowPage,
} from './components';
import { ProgressiveStrategyView } from './ProgressiveStrategyView';
import { ProgressiveTrialView } from './ProgressiveTrialView';
import { useReadingSetupWorkflow } from './useReadingSetupWorkflow';
import { useStrategyReviewController } from './useStrategyReviewController';

export function StrategyPage() {
  const { id = '' } = useParams();
  const { userBook } = useReadingSetupWorkflow();
  const [feedback, setFeedback] = useState('');
  const controller = useStrategyReviewController({
    userBookId: id,
    userBook,
    onRevisionCompleted: () => setFeedback(''),
    onRecoverableFeedback: setFeedback,
  });

  const book = userBook.sharedBook;
  if (controller.loading) return <WorkflowPage book={book} kicker="BEFORE YOU READ · 读前准备" title="读之前，先看地图"><WorkflowMessage title="正在展开读前简报">访谈结果和当前草稿正在读取。</WorkflowMessage></WorkflowPage>;
  if (controller.loadError) return <WorkflowPage book={book} kicker="BEFORE YOU READ · 读前准备" title="读之前，先看地图"><WorkflowMessage title="暂时读不到当前草稿" action={<button className="button button-ghost" type="button" onClick={controller.retryLoad}>重新读取</button>}>{controller.loadError.message}</WorkflowMessage></WorkflowPage>;
  const snapshot = controller.snapshot!;

  return (
    <WorkflowPage book={book} kicker="BEFORE YOU READ · 读前准备" title="读之前，先看地图">
      <div className="strategy-review">
        {controller.selectionActive ? <ProgressiveTrialView
          model={controller.trialModel}
          onSelectOrdinal={controller.selectTrialOrdinal}
        /> : <ProgressiveStrategyView model={controller.strategyModel!} />}
        {controller.selectionActive ? (
          <div className="workflow-actions workflow-actions-final"><BackToShelf /></div>
        ) : (
          <>
            {snapshot.canAdjust ? (
              <AdjustmentForm
                value={feedback}
                onChange={setFeedback}
                onSubmit={() => controller.submitFeedback(feedback)}
                pending={controller.feedbackPending}
                label={`有哪里不合适？还可以调整 ${Math.max(0, snapshot.adjustmentLimit - snapshot.adjustmentCount)} 次`}
                placeholder="比如：导读再短一点；术语保留原文；不要解释已经熟悉的背景。"
              />
            ) : <div className="adjustment-limit">已经达到 {snapshot.adjustmentLimit} 次调整上限。当前草稿仍可以确认并生成最后一轮试读。</div>}
            {controller.mutationError ? <div className="form-error" role="alert">{controller.mutationError}</div> : null}
            <div className="workflow-actions workflow-actions-final">
              <button
                className="button button-primary"
                type="button"
                disabled={controller.approveDisabled}
                onClick={controller.approve}
              >
                {controller.approvePending ? '正在创建试读…' : '处理方式没问题，生成试读'}
              </button>
              <BackToShelf />
            </div>
          </>
        )}
      </div>
    </WorkflowPage>
  );
}
