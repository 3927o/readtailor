import { describe, expect, it } from 'vitest';
import {
  AGENT_RUN_DEFAULT_JOB_OPTIONS,
  isTerminalAgentRunFailure,
} from './index';

describe('Agent run retry policy', () => {
  it('uses bounded exponential retries', () => {
    expect(AGENT_RUN_DEFAULT_JOB_OPTIONS).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 2_000 },
    });
  });

  it('clears the active run only after retries are exhausted or failure is unrecoverable', () => {
    expect(
      isTerminalAgentRunFailure(
        { attemptsMade: 1, opts: { attempts: 3 } },
        { name: 'Error' },
      ),
    ).toBe(false);
    expect(
      isTerminalAgentRunFailure(
        { attemptsMade: 3, opts: { attempts: 3 } },
        { name: 'Error' },
      ),
    ).toBe(true);
    expect(
      isTerminalAgentRunFailure(
        { attemptsMade: 1, opts: { attempts: 3 } },
        { name: 'UnrecoverableError' },
      ),
    ).toBe(true);
  });
});
