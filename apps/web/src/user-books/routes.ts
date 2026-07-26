/** Maps persisted workflow states onto the supported Setup, Reader, or shelf destinations. */

import type { UserBookWorkflowStatus } from '@readtailor/contracts';
import type { UserBookSummary } from './api/http';

export function routeForWorkflow(userBookId: string, workflowStatus: UserBookWorkflowStatus): string {
  const root = `/user-books/${encodeURIComponent(userBookId)}`;
  switch (workflowStatus) {
    case 'on_shelf':
      return `${root}/reading-setup`;
    case 'active_reading':
      return `${root}/read`;
    case 'interviewing':
    case 'strategy_review':
    case 'trial_generating':
    case 'trial_generation_failed':
    case 'trial_review':
      return '/';
  }
}

export function routeForUserBook(userBook: UserBookSummary): string {
  if (userBook.sharedBook.status !== 'ready') {
    return `/books/${encodeURIComponent(userBook.sharedBook.id)}/processing`;
  }
  return routeForWorkflow(userBook.id, userBook.workflowStatus);
}
