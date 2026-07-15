import { useQuery } from '@tanstack/react-query';
import { Navigate, Outlet, useLocation, useParams } from 'react-router';
import { getUserBook } from './api';
import { WorkflowFallback } from './components';
import { userBookQueryKeys } from './queryKeys';
import { routeForUserBook } from './routes';
import type { ReadingSetupWorkflowContext } from './useReadingSetupWorkflow';

export function ReadingSetupRoute() {
  const { id = '' } = useParams();
  const location = useLocation();
  const query = useQuery({
    queryKey: userBookQueryKeys.detail(id),
    queryFn: () => getUserBook(id),
    enabled: Boolean(id),
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
