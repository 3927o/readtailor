import type { UserBookSummary, WorkflowStatus } from './api';

export function routeForWorkflow(userBookId: string, workflowStatus: WorkflowStatus): string {
  const root = `/user-books/${encodeURIComponent(userBookId)}`;
  switch (workflowStatus) {
    case 'on_shelf':
    case 'interviewing':
      return `${root}/interview`;
    case 'strategy_review':
      return `${root}/strategy`;
    case 'trial_generating':
    case 'trial_generation_failed':
    case 'trial_review':
      return `${root}/trial`;
    case 'active_reading':
      return `${root}/read`;
  }
}

export function routeForUserBook(userBook: UserBookSummary): string {
  if (userBook.sharedBook.status !== 'ready') {
    return `/books/${encodeURIComponent(userBook.sharedBook.id)}/processing`;
  }
  return routeForWorkflow(userBook.id, userBook.workflowStatus);
}
