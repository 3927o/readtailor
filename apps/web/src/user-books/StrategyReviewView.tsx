import type { UserBookSharedBook } from './api/http';
import {
  AdjustmentForm,
  BackToShelf,
  WorkflowPage,
} from './components';
import { ProgressiveStrategyView, type ProgressiveStrategyModel } from './ProgressiveStrategyView';

interface StrategyReviewViewProps {
  book: UserBookSharedBook;
  model: ProgressiveStrategyModel;
  feedback: string;
  onFeedbackChange(value: string): void;
  onFeedbackSubmit(): void;
  feedbackPending: boolean;
  feedbackDisabled?: boolean;
  canAdjust: boolean;
  adjustmentCount: number;
  adjustmentLimit: number;
  mutationError?: string | null;
  approvePending: boolean;
  approveDisabled: boolean;
  onApprove(): void;
  approveLabel?: string;
}

export function StrategyReviewView({
  book,
  model,
  feedback,
  onFeedbackChange,
  onFeedbackSubmit,
  feedbackPending,
  feedbackDisabled = false,
  canAdjust,
  adjustmentCount,
  adjustmentLimit,
  mutationError,
  approvePending,
  approveDisabled,
  onApprove,
  approveLabel,
}: StrategyReviewViewProps) {
  return (
    <WorkflowPage book={book} kicker="BEFORE YOU READ · 读前准备" title="读之前，先看地图">
      <div className="strategy-review">
        <ProgressiveStrategyView model={model} />
        {canAdjust ? (
          <AdjustmentForm
            value={feedback}
            onChange={onFeedbackChange}
            onSubmit={onFeedbackSubmit}
            pending={feedbackPending}
            disabled={feedbackDisabled}
            label={`有哪里不合适？还可以调整 ${Math.max(0, adjustmentLimit - adjustmentCount)} 次`}
            placeholder={feedbackDisabled
              ? '处理方式生成完成后，可以在这里提出调整意见。'
              : '比如：导读再短一点；术语保留原文；不要解释已经熟悉的背景。'}
          />
        ) : (
          <div className="adjustment-limit">已经达到 {adjustmentLimit} 次调整上限。当前草稿仍可以确认并生成最后一轮试读。</div>
        )}
        {mutationError ? <div className="form-error" role="alert">{mutationError}</div> : null}
        <div className="workflow-actions workflow-actions-final">
          <button
            className="button button-primary"
            type="button"
            disabled={approveDisabled}
            onClick={onApprove}
          >
            {approvePending ? '正在创建试读…' : (approveLabel ?? '处理方式没问题，生成试读')}
          </button>
          <BackToShelf />
        </div>
      </div>
    </WorkflowPage>
  );
}
