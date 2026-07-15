import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router';
import {
  approveStrategyForTrial,
  ApiError,
  getStrategy,
  submitStrategyFeedback,
} from './api';
import type { StrategySnapshot } from './api';
import {
  AdjustmentForm,
  BackToShelf,
  WorkflowFallback,
  WorkflowMessage,
  WorkflowPage,
} from './components';
import { ProgressiveStrategyView } from './ProgressiveStrategyView';
import { userBookQueryKeys } from './queryKeys';
import { useWorkflowGate } from './useWorkflowGate';

interface StrategyFeedbackCommand {
  draftId: string;
  feedback: string;
  idempotencyKey: string;
}

interface ApproveStrategyCommand {
  draftId: string;
  idempotencyKey: string;
}

export function StrategyPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const gate = useWorkflowGate(id, ['strategy_review']);
  const currentDraftId = gate.query.data?.currentStrategyDraftVersionId ?? '';
  const strategy = useQuery({
    queryKey: userBookQueryKeys.strategy(id, currentDraftId),
    queryFn: () => getStrategy(id, currentDraftId),
    enabled: gate.active && Boolean(currentDraftId),
  });
  const [feedback, setFeedback] = useState('');
  const feedbackCommand = useRef<StrategyFeedbackCommand | null>(null);
  const approveCommand = useRef<ApproveStrategyCommand | null>(null);
  const resyncOnConflict = async (error: Error) => {
    if (error instanceof ApiError && error.status === 409) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(id) }),
        queryClient.invalidateQueries({ queryKey: userBookQueryKeys.strategies(id) }),
      ]);
    }
  };
  const saveSnapshot = async (snapshot: StrategySnapshot) => {
    feedbackCommand.current = null;
    queryClient.setQueryData(userBookQueryKeys.strategy(id, snapshot.draftId), snapshot);
    setFeedback('');
    await queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(id) });
  };
  const revise = useMutation<StrategySnapshot, Error, StrategyFeedbackCommand>({
    mutationFn: (command) => submitStrategyFeedback(
      id,
      command.draftId,
      command.feedback,
      command.idempotencyKey,
    ),
    onSuccess: saveSnapshot,
    onError: resyncOnConflict,
  });
  const approve = useMutation<Awaited<ReturnType<typeof approveStrategyForTrial>>, Error, ApproveStrategyCommand>({
    mutationFn: (command) => approveStrategyForTrial(id, command.draftId, command.idempotencyKey),
    onSuccess: async (trial) => {
      approveCommand.current = null;
      queryClient.setQueryData(userBookQueryKeys.trial(id, trial.revisionId), trial);
      await queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(id) });
      navigate(`/user-books/${encodeURIComponent(id)}/trial`, { replace: true });
    },
    onError: resyncOnConflict,
  });
  const submitFeedback = () => {
    if (!strategy.data) return;
    const trimmedFeedback = feedback.trim();
    const previous = feedbackCommand.current;
    const command = previous?.draftId === strategy.data.draftId && previous.feedback === trimmedFeedback
      ? previous
      : {
          draftId: strategy.data.draftId,
          feedback: trimmedFeedback,
          idempotencyKey: crypto.randomUUID(),
        };
    feedbackCommand.current = command;
    revise.mutate(command);
  };
  const submitApproval = () => {
    if (!strategy.data) return;
    const previous = approveCommand.current;
    const command = previous?.draftId === strategy.data.draftId
      ? previous
      : { draftId: strategy.data.draftId, idempotencyKey: crypto.randomUUID() };
    approveCommand.current = command;
    approve.mutate(command);
  };

  if (gate.query.isPending || !gate.active) return <WorkflowFallback title="正在打开处理方式" detail="正在确认当前草稿版本。" />;
  if (gate.query.isError) return <WorkflowFallback title="处理方式暂时打不开" detail={gate.query.error.message} retry={() => void gate.query.refetch()} />;
  const book = gate.query.data.sharedBook;
  if (strategy.isPending) return <WorkflowPage book={book} kicker="BEFORE YOU READ · 读前准备" title="读之前，先看地图"><WorkflowMessage title="正在展开读前简报">访谈结果和当前草稿正在读取。</WorkflowMessage></WorkflowPage>;
  if (strategy.isError) return <WorkflowPage book={book} kicker="BEFORE YOU READ · 读前准备" title="读之前，先看地图"><WorkflowMessage title="暂时读不到当前草稿" action={<button className="button button-ghost" type="button" onClick={() => void strategy.refetch()}>重新读取</button>}>{strategy.error.message}</WorkflowMessage></WorkflowPage>;
  const snapshot = strategy.data;
  const mutationError = revise.error?.message ?? approve.error?.message;

  return (
    <WorkflowPage book={book} kicker="BEFORE YOU READ · 读前准备" title="读之前，先看地图">
      <div className="strategy-review">
        <ProgressiveStrategyView model={{
          mode: 'committed',
          source: 'interview',
          briefing: snapshot.readingBriefing,
          strategySummary: snapshot.userFacingSummary,
          nodes: snapshot.trialCandidatePreviews,
          draftVersion: snapshot.draftVersion,
        }} />
        {snapshot.canAdjust ? (
          <AdjustmentForm
            value={feedback}
            onChange={setFeedback}
            onSubmit={submitFeedback}
            pending={revise.isPending}
            label={`有哪里不合适？还可以调整 ${Math.max(0, snapshot.adjustmentLimit - snapshot.adjustmentCount)} 次`}
            placeholder="比如：导读再短一点；术语保留原文；不要解释已经熟悉的背景。"
          />
        ) : <div className="adjustment-limit">已经达到 {snapshot.adjustmentLimit} 次调整上限。当前草稿仍可以确认并生成最后一轮试读。</div>}
        {mutationError ? <div className="form-error" role="alert">{mutationError}</div> : null}
        <div className="workflow-actions workflow-actions-final">
          <button
            className="button button-primary"
            type="button"
            disabled={approve.isPending || revise.isPending}
            onClick={submitApproval}
          >
            {approve.isPending ? '正在创建试读…' : '处理方式没问题，生成试读'}
          </button>
          <BackToShelf />
        </div>
      </div>
    </WorkflowPage>
  );
}
