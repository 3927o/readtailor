/** Verifies navigation for the active workflow and database-only legacy statuses. */

import { describe, expect, it } from 'vitest';
import { routeForWorkflow } from './routes';

describe('routeForWorkflow', () => {
  it('keeps the new setup and Reader as the only user-book workflow destinations', () => {
    expect(routeForWorkflow('book/1', 'on_shelf'))
      .toBe('/user-books/book%2F1/reading-setup');
    expect(routeForWorkflow('book/1', 'active_reading'))
      .toBe('/user-books/book%2F1/read');
  });

  it.each([
    'interviewing',
    'strategy_review',
    'trial_generating',
    'trial_generation_failed',
    'trial_review',
  ] as const)('falls back to the shelf for legacy status %s', (status) => {
    expect(routeForWorkflow('book/1', status)).toBe('/');
  });
});
