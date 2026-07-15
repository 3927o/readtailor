import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_LIMIT,
  canAdjustReadingSetup,
  canAdoptTrial,
  isCurrentStrategyDraftReview,
  isCurrentTrialReview,
  workflowPointerInvariantViolation,
  type ReadingSetupWorkflowPointers,
} from './reading-setup-state';

const pointers: ReadingSetupWorkflowPointers = {
  workflowStatus: 'on_shelf',
  currentInterviewSessionId: null,
  currentStrategyDraftVersionId: null,
  currentTrialRevisionId: null,
  currentStrategyVersionId: null,
};

describe('reading setup workflow state', () => {
  it.each([
    [{ ...pointers, workflowStatus: 'interviewing' as const }, 'interview_session_required'],
    [{ ...pointers, workflowStatus: 'strategy_review' as const }, 'strategy_draft_required'],
    [{ ...pointers, workflowStatus: 'trial_generating' as const }, 'trial_pointers_required'],
    [{ ...pointers, workflowStatus: 'trial_generation_failed' as const }, 'trial_pointers_required'],
    [{ ...pointers, workflowStatus: 'trial_review' as const }, 'trial_pointers_required'],
    [{ ...pointers, workflowStatus: 'active_reading' as const }, 'formal_strategy_required'],
  ])('reports the required pointer for %s', (state, violation) => {
    expect(workflowPointerInvariantViolation(state)).toBe(violation);
  });

  it('accepts complete pointers and identifies current review entities', () => {
    const strategy = {
      ...pointers,
      workflowStatus: 'strategy_review' as const,
      currentStrategyDraftVersionId: 'draft-current',
    };
    const trial = {
      ...strategy,
      workflowStatus: 'trial_review' as const,
      currentTrialRevisionId: 'trial-current',
    };

    expect(workflowPointerInvariantViolation(strategy)).toBeNull();
    expect(workflowPointerInvariantViolation(trial)).toBeNull();
    expect(isCurrentStrategyDraftReview(strategy, 'draft-current')).toBe(true);
    expect(isCurrentStrategyDraftReview(strategy, 'draft-old')).toBe(false);
    expect(isCurrentTrialReview(trial, 'trial-current')).toBe(true);
    expect(isCurrentTrialReview(trial, 'trial-old')).toBe(false);
  });

  it('limits adjustments to the current entity below the configured cap', () => {
    expect(canAdjustReadingSetup(true, ADJUSTMENT_LIMIT - 1)).toBe(true);
    expect(canAdjustReadingSetup(true, ADJUSTMENT_LIMIT)).toBe(false);
    expect(canAdjustReadingSetup(false, 0)).toBe(false);
  });

  it('allows adoption only for the current published revision with exactly three ready segments', () => {
    const readySegments = [{ status: 'ready' as const }, { status: 'ready' as const }, { status: 'ready' as const }];

    expect(canAdoptTrial({
      isCurrent: true,
      revisionStatus: 'published',
      segments: readySegments,
    })).toBe(true);
    expect(canAdoptTrial({
      isCurrent: true,
      revisionStatus: 'published',
      segments: [...readySegments, { status: 'ready' }],
    })).toBe(false);
    expect(canAdoptTrial({
      isCurrent: true,
      revisionStatus: 'published',
      segments: [{ status: 'ready' }, { status: 'generating' }, { status: 'ready' }],
    })).toBe(false);
    expect(canAdoptTrial({
      isCurrent: false,
      revisionStatus: 'published',
      segments: readySegments,
    })).toBe(false);
  });
});
