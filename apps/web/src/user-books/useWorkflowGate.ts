import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { getUserBook } from './api';
import type { WorkflowStatus } from './api';
import { userBookQueryKeys } from './queryKeys';
import { routeForUserBook } from './routes';

export function useWorkflowGate(userBookId: string, allowed: readonly WorkflowStatus[]) {
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: userBookQueryKeys.detail(userBookId),
    queryFn: () => getUserBook(userBookId),
    enabled: Boolean(userBookId),
    refetchInterval: (current) => {
      const status = current.state.data?.workflowStatus;
      return status && ['interviewing', 'trial_generating'].includes(status) ? 1800 : false;
    },
  });
  const active = Boolean(
    query.data
    && query.data.sharedBook.status === 'ready'
    && allowed.includes(query.data.workflowStatus),
  );

  useEffect(() => {
    if (query.data && !active) {
      navigate(routeForUserBook(query.data), { replace: true });
    }
  }, [active, navigate, query.data]);

  return { query, active };
}
