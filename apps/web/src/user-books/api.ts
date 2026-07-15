export { ApiError } from './apiError';

export {
  getUserBook,
  getUserBooks,
} from './api/http';
export type {
  ReadingProgressSummary,
  UserBookDetail,
  UserBookListResponse,
  UserBookSharedBook,
  UserBookSummary,
  WorkflowStatus,
} from './api/http';

export {
  getInterview,
  resumeInterview,
  startInterview,
  streamInterviewAnswer,
  streamResumeInterview,
} from './api/interview';
export type {
  InterviewClientStreamEvent,
  InterviewHistoryItem,
  InterviewOption,
  InterviewQuestion,
  InterviewSnapshot,
  InterviewStreamHandlers,
} from './api/interview';

export {
  getStrategy,
  streamStrategyFeedback,
} from './api/strategy';
export type {
  StrategyRevisionClientEvent,
  StrategyRevisionStreamHandlers,
  StrategySnapshot,
} from './api/strategy';

export {
  adoptTrial,
  getTrial,
  markTrialSampleViewed,
  retryTrial,
  streamApproveStrategyForTrial,
  streamTrialFeedback,
} from './api/trial';
export type {
  TailoredAnnotation,
  TailoredContent,
  TextPosition,
  TextRange,
  TrialSample,
  TrialSelectionClientEvent,
  TrialSelectionStreamHandlers,
  TrialSnapshot,
} from './api/trial';

export {
  getCurrentReadingSetupOperation,
  getReadingSetupOperation,
  resumeReadingSetupOperation,
} from './api/operations';
