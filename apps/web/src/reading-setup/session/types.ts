/** Defines the session-level page model and commands exposed to the formal UI. */

import type { ReadingSetupTranscriptEntry } from '../transcript/types';
import type { ReadingSetupConnection } from './runConnection';

export interface ReadingSetupBookView {
  id: string;
  title: string;
  authors: string[];
}

export interface ReadingSetupPageView {
  book: ReadingSetupBookView;
  entries: ReadingSetupTranscriptEntry[];
  connection: ReadingSetupConnection;
  interactionsLocked: boolean;
}

export interface AnswerQuestionCommand {
  toolCallId: string;
  selectedOptionIds: string[];
  freeText: string | null;
}

export interface SendFeedbackCommand {
  targetToolCallId: string;
  message: string;
}

export interface ReadingSetupCommands {
  answerQuestion(input: AnswerQuestionCommand): void | Promise<void>;
  sendFeedback(input: SendFeedbackCommand): void | Promise<void>;
  confirmStrategy(toolCallId: string): void | Promise<void>;
  confirmTrial(toolCallId: string): void | Promise<void>;
  retryConnection(): void | Promise<void>;
}

export interface ReadingSetupController {
  view: ReadingSetupPageView;
  commands: ReadingSetupCommands;
}
