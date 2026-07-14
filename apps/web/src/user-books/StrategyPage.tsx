import { useState } from 'react';
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
  AssistanceContent,
  BackToShelf,
  BriefCard,
  WorkflowFallback,
  WorkflowMessage,
  WorkflowPage,
} from './components';
import { useWorkflowGate } from './useWorkflowGate';

export function StrategyPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const gate = useWorkflowGate(id, ['strategy_review']);
  const strategy = useQuery({
    queryKey: ['user-book', id, 'strategy'],
    queryFn: () => getStrategy(id),
    enabled: gate.active,
  });
  const [feedback, setFeedback] = useState('');
  const resyncOnConflict = async (error: Error) => {
    if (error instanceof ApiError && error.status === 409) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['user-book', id] }),
        queryClient.invalidateQueries({ queryKey: ['user-book', id, 'strategy'] }),
      ]);
    }
  };
  const saveSnapshot = (snapshot: StrategySnapshot) => {
    queryClient.setQueryData(['user-book', id, 'strategy'], snapshot);
    setFeedback('');
  };
  const revise = useMutation({
    mutationFn: () => {
      if (!strategy.data) throw new Error('当前处理方式已经失效。');
      return submitStrategyFeedback(id, strategy.data.draftId, feedback.trim());
    },
    onSuccess: saveSnapshot,
    onError: resyncOnConflict,
  });
  const approve = useMutation({
    mutationFn: () => {
      if (!strategy.data) throw new Error('当前处理方式还没有准备好。');
      return approveStrategyForTrial(id, strategy.data.draftId);
    },
    onSuccess: async (trial) => {
      queryClient.setQueryData(['user-book', id, 'trial'], trial);
      await queryClient.invalidateQueries({ queryKey: ['user-book', id] });
      navigate(`/user-books/${encodeURIComponent(id)}/trial`, { replace: true });
    },
    onError: resyncOnConflict,
  });

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
        <BriefCard briefing={snapshot.readingBriefing} />
        <section className="strategy-copy">
          <div className="strategy-version">处理方式 · 草稿 V{snapshot.draftVersion}</div>
          <h2>我们会怎样陪你读这本书</h2>
          <AssistanceContent content={snapshot.userFacingSummary} />
        </section>
        {snapshot.canAdjust ? (
          <AdjustmentForm
            value={feedback}
            onChange={setFeedback}
            onSubmit={() => revise.mutate()}
            pending={revise.isPending}
            label={`有哪里不合适？还可以调整 ${Math.max(0, snapshot.adjustmentLimit - snapshot.adjustmentCount)} 次`}
            placeholder="比如：导读再短一点；术语保留原文；不要解释已经熟悉的背景。"
          />
        ) : <div className="adjustment-limit">已经达到 {snapshot.adjustmentLimit} 次调整上限。当前草稿仍可以确认并生成最后一轮试读。</div>}
        {mutationError ? <div className="form-error" role="alert">{mutationError}</div> : null}
        <div className="workflow-actions workflow-actions-final">
          <button className="button button-primary" type="button" disabled={approve.isPending || revise.isPending} onClick={() => approve.mutate()}>
            {approve.isPending ? '正在创建试读…' : '处理方式没问题，生成试读'}
          </button>
          <BackToShelf />
        </div>
      </div>
    </WorkflowPage>
  );
}
