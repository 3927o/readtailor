import { describe, expect, it } from 'vitest';
import {
  projectReadingSetupOperation,
  type ReadingSetupOperationProjectionInput,
} from './reading-setup-operation';

const baseOperation: ReadingSetupOperationProjectionInput = {
  id: '44444444-5555-4666-8777-888888888888',
  kind: 'strategy_revision',
  source: 'strategy_feedback',
  baseStrategyDraftVersionId: '55555555-6666-4777-8888-999999999999',
  baseTrialRevisionId: null,
  payload: {
    source: 'strategy_feedback',
    strategyDraftVersionId: '55555555-6666-4777-8888-999999999999',
    feedback: 'make it clearer',
  },
  status: 'pending',
  attemptCount: 1,
  resultStrategyDraftVersionId: null,
  resultTrialRevisionId: null,
  errorSummary: null,
};

describe('projectReadingSetupOperation', () => {
  it('projects resumability and recoverable feedback for active revision operations', () => {
    expect(projectReadingSetupOperation(baseOperation)).toMatchObject({
      status: 'pending',
      canResume: true,
      recoverableInput: { feedback: 'make it clearer' },
    });
    expect(projectReadingSetupOperation({ ...baseOperation, status: 'running' }, true)).toMatchObject({
      status: 'running',
      canResume: true,
    });
    expect(projectReadingSetupOperation({ ...baseOperation, status: 'running' }, false)).toMatchObject({
      status: 'running',
      canResume: false,
    });
  });

  it('projects completed feedback and approval results', () => {
    expect(projectReadingSetupOperation({
      ...baseOperation,
      status: 'completed',
      resultStrategyDraftVersionId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
    })).toMatchObject({
      status: 'completed',
      resultDraftId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
      recoverableInput: null,
    });
    expect(projectReadingSetupOperation({
      ...baseOperation,
      kind: 'trial_selection',
      source: 'strategy_approve',
      payload: {
        source: 'strategy_approve',
        strategyDraftVersionId: baseOperation.baseStrategyDraftVersionId,
      },
      status: 'completed',
      resultStrategyDraftVersionId: null,
      resultTrialRevisionId: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
    })).toMatchObject({
      kind: 'trial_selection',
      status: 'completed',
      resultTrialRevisionId: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
      recoverableInput: null,
    });
  });

  it('rejects inconsistent discriminators and incomplete terminal results', () => {
    expect(projectReadingSetupOperation({
      ...baseOperation,
      source: 'trial_feedback',
    })).toBeNull();
    expect(projectReadingSetupOperation({
      ...baseOperation,
      status: 'completed',
    })).toBeNull();
    expect(projectReadingSetupOperation({
      ...baseOperation,
      status: 'failed',
    })).toBeNull();
  });
});
