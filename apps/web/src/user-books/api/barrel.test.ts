import { describe, expect, it } from 'vitest';
import * as barrel from '../api';
import { ApiError } from '../apiError';
import {
  getUserBook,
  getUserBooks,
} from './http';
import {
  getInterview,
  resumeInterview,
  startInterview,
  streamInterviewAnswer,
  streamResumeInterview,
} from './interview';
import {
  getCurrentReadingSetupOperation,
  getReadingSetupOperation,
  resumeReadingSetupOperation,
} from './operations';
import {
  getStrategy,
  streamStrategyFeedback,
} from './strategy';
import {
  adoptTrial,
  getTrial,
  markTrialSampleViewed,
  retryTrial,
  streamApproveStrategyForTrial,
  streamTrialFeedback,
} from './trial';

describe('user-books API compatibility barrel', () => {
  it('re-exports the same runtime API implementations after the module split', () => {
    expect(barrel).toMatchObject({
      ApiError,
      getUserBook,
      getUserBooks,
      getInterview,
      resumeInterview,
      startInterview,
      streamInterviewAnswer,
      streamResumeInterview,
      getStrategy,
      streamStrategyFeedback,
      getTrial,
      streamApproveStrategyForTrial,
      markTrialSampleViewed,
      retryTrial,
      streamTrialFeedback,
      adoptTrial,
      getCurrentReadingSetupOperation,
      getReadingSetupOperation,
      resumeReadingSetupOperation,
    });
  });
});
