import { useOutletContext } from 'react-router';
import type { UserBookDetail } from './api/http';

export interface ReadingSetupWorkflowContext {
  userBook: UserBookDetail;
}

export function useReadingSetupWorkflow(): ReadingSetupWorkflowContext {
  return useOutletContext<ReadingSetupWorkflowContext>();
}
