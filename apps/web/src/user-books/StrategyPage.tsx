import { useState } from 'react';
import { useParams } from 'react-router';
import {
  BackToShelf,
  WorkflowMessage,
  WorkflowPage,
} from './components';
import { ProgressiveTrialView } from './ProgressiveTrialView';
import { StrategyReviewView } from './StrategyReviewView';
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

  if (controller.selectionActive) {
    return (
      <WorkflowPage book={book} kicker="BEFORE YOU READ · 读前准备" title="读之前，先看地图">
        <div className="strategy-review">
          <ProgressiveTrialView
            model={controller.trialModel}
            onSelectOrdinal={controller.selectTrialOrdinal}
          />
          <div className="workflow-actions workflow-actions-final"><BackToShelf /></div>
        </div>
      </WorkflowPage>
    );
  }

  return <StrategyReviewView
    book={book}
    model={controller.strategyModel!}
    feedback={feedback}
    onFeedbackChange={setFeedback}
    onFeedbackSubmit={() => controller.submitFeedback(feedback)}
    feedbackPending={controller.feedbackPending}
    canAdjust={snapshot.canAdjust}
    adjustmentCount={snapshot.adjustmentCount}
    adjustmentLimit={snapshot.adjustmentLimit}
    mutationError={controller.mutationError}
    approvePending={controller.approvePending}
    approveDisabled={controller.approveDisabled}
    onApprove={controller.approve}
  />;
}
