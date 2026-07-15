import { describe, expect, it } from 'vitest';
import {
  advanceReadingSetupEventFence,
  EMPTY_READING_SETUP_EVENT_FENCE,
} from './eventFence';

describe('reading setup event fence', () => {
  it('rejects duplicate sequence, older attempts, and older speculative epochs', () => {
    const first = advanceReadingSetupEventFence(EMPTY_READING_SETUP_EVENT_FENCE, {
      operationId: 'operation-1',
      operationAttempt: 1,
      sequence: 1,
      speculativeEpoch: 2,
    })!;

    expect(advanceReadingSetupEventFence(first, {
      operationId: 'operation-1',
      operationAttempt: 1,
      sequence: 1,
      speculativeEpoch: 2,
    })).toBeNull();
    expect(advanceReadingSetupEventFence(first, {
      operationId: 'operation-1',
      operationAttempt: 0,
      sequence: 10,
      speculativeEpoch: 2,
    })).toBeNull();
    expect(advanceReadingSetupEventFence(first, {
      operationId: 'operation-1',
      operationAttempt: 1,
      sequence: 2,
      speculativeEpoch: 1,
    })).toBeNull();
  });

  it('resets sequence and epoch fencing for a newer attempt', () => {
    const next = advanceReadingSetupEventFence({
      operationId: 'operation-1',
      operationAttempt: 1,
      sequence: 20,
      speculativeEpoch: 4,
    }, {
      operationId: 'operation-1',
      operationAttempt: 2,
      sequence: 1,
      speculativeEpoch: 1,
    });

    expect(next).toEqual({
      operationId: 'operation-1',
      operationAttempt: 2,
      sequence: 1,
      speculativeEpoch: 1,
    });
  });
});
