import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet, useLocation, useParams } from 'react-router';
import { getUserBook, type UserBookDetail } from './api/http';
import { WorkflowFallback } from './components';
import { userBookQueryKeys } from './queryKeys';
import { routeForUserBook } from './routes';
import type { ReadingSetupWorkflowContext } from './useReadingSetupWorkflow';

const WORKFLOW_STAGE: Record<UserBookDetail['workflowStatus'], number> = {
  on_shelf: 0,
  interviewing: 1,
  strategy_review: 2,
  trial_generating: 3,
  trial_generation_failed: 3,
  trial_review: 4,
  active_reading: 5,
};

export function mergeUserBookDetail(
  previous: UserBookDetail | undefined,
  next: UserBookDetail,
): UserBookDetail {
  if (!previous) return next;
  if (next.updatedAt > previous.updatedAt) return next;
  if (WORKFLOW_STAGE[next.workflowStatus] > WORKFLOW_STAGE[previous.workflowStatus]) {
    return { ...next, updatedAt: previous.updatedAt };
  }
  return previous;
}

export function ReadingSetupRoute() {
  const { id = '' } = useParams();
  const location = useLocation();
  const query = useQuery<UserBookDetail>({
    queryKey: userBookQueryKeys.detail(id),
    queryFn: () => getUserBook(id),
    enabled: Boolean(id),
    structuralSharing: (previous, next) => mergeUserBookDetail(
      previous as UserBookDetail | undefined,
      next as UserBookDetail,
    ),
    refetchInterval: (current) => {
      const status = current.state.data?.workflowStatus;
      return status && ['interviewing', 'trial_generating'].includes(status) ? 1800 : false;
    },
  });

  if (query.isPending) {
    return <WorkflowFallback title="正在打开这本书" detail="正在恢复上次离开的阅读准备位置。" />;
  }
  if (query.isError) {
    return <WorkflowFallback title="这本书暂时打不开" detail={query.error.message} retry={() => void query.refetch()} />;
  }

  const canonicalPath = routeForUserBook(query.data);
  if (location.pathname !== canonicalPath) return <Navigate replace to={canonicalPath} />;

  const context: ReadingSetupWorkflowContext = { userBook: query.data };
  return <Outlet context={context} />;
}
