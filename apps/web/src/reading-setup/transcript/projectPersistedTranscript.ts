/** Projects committed Agent messages and user actions into their stable transcript order. */

import type {
  AgentAction,
  AgentJsonValue,
  AgentSessionState,
} from '@readtailor/contracts';
import { indexAgentTranscript } from '@readtailor/agent-state';
import {
  confirmationTargets,
  projectToolEntry,
} from './projectToolEntry';
import type {
  QuestionAnswerView,
  ReadingSetupActionState,
  ReadingSetupTranscriptEntry,
} from './types';

type QuestionAnswerAction = Extract<AgentAction, { type: 'question_answer' }>;

function userText(content: string | Array<{ text: string }>): string {
  return typeof content === 'string'
    ? content
    : content.map((item) => item.text).join('');
}

function questionAnswer(
  action: QuestionAnswerAction,
  argumentsValue: AgentJsonValue | undefined,
): QuestionAnswerView {
  const args = argumentsValue && typeof argumentsValue === 'object'
    && !Array.isArray(argumentsValue)
    ? argumentsValue as Record<string, unknown>
    : null;
  const options = Array.isArray(args?.options) ? args.options : [];
  const labels = options.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const option = value as Record<string, unknown>;
    return (
      typeof option.id === 'string'
      && typeof option.label === 'string'
      && action.selectedOptionIds.includes(option.id)
    )
      ? [option.label]
      : [];
  });
  return {
    selectedOptionIds: [...action.selectedOptionIds],
    freeText: action.freeText,
    displayText: [...labels, action.freeText]
      .filter((value): value is string => Boolean(value))
      .join('。'),
  };
}

function actionsByTimestamp(actions: readonly AgentAction[]): Map<number, AgentAction> {
  return new Map(actions.map((action) => [Date.parse(action.submittedAt), action]));
}

export function projectPersistedReadingSetupTranscript(
  state: AgentSessionState,
): ReadingSetupTranscriptEntry[] {
  const tools = indexAgentTranscript(state.messages);
  const confirmations = confirmationTargets(state);
  const answerByQuestion = new Map(
    state.actions.flatMap((action) =>
      action.type === 'question_answer'
        ? [[
            action.questionToolCallId,
            questionAnswer(action, tools.get(action.questionToolCallId)?.arguments),
          ] as const]
        : []),
  );
  const committedActionAt = actionsByTimestamp(state.actions);
  const latestSuccessfulByName = new Map<string, string>();
  for (const message of state.messages) {
    if (message.role !== 'assistant') continue;
    for (const content of message.content) {
      if (content.type !== 'toolCall') continue;
      if (tools.get(content.id)?.status === 'succeeded') {
        latestSuccessfulByName.set(content.name, content.id);
      }
    }
  }

  const entries: ReadingSetupTranscriptEntry[] = [];
  state.messages.forEach((message, messageIndex) => {
    if (message.role === 'toolResult') return;
    if (message.role === 'user') {
      const action = committedActionAt.get(message.timestamp);
      if (action?.type === 'confirmation') return;
      if (action?.type === 'question_answer') {
        const answer = questionAnswer(
          action,
          tools.get(action.questionToolCallId)?.arguments,
        );
        entries.push({
          id: `persisted-action-${action.submittedAt}`,
          kind: 'user',
          text: answer.displayText,
          delivery: 'sent',
        });
        return;
      }
      if (action?.type === 'feedback') {
        entries.push({
          id: `persisted-action-${action.submittedAt}`,
          kind: 'user',
          text: action.message,
          delivery: 'sent',
        });
        return;
      }
      entries.push({
        id: `persisted-message-${messageIndex}`,
        kind: 'user',
        text: userText(message.content),
        delivery: 'sent',
      });
      return;
    }

    message.content.forEach((content, contentIndex) => {
      if (content.type === 'text' && content.text) {
        entries.push({
          id: `persisted-message-${messageIndex}-text-${contentIndex}`,
          kind: 'assistant',
          text: content.text,
          streaming: false,
        });
        return;
      }
      if (content.type !== 'toolCall') return;
      const indexed = tools.get(content.id);
      const confirmation: ReadingSetupActionState = confirmations.has(content.id)
        ? 'completed'
        : (
            indexed?.status === 'succeeded'
            && latestSuccessfulByName.get(content.name) !== content.id
            && (content.name === 'publish_strategy' || content.name === 'generate_trial_slice')
          )
          ? 'superseded'
          : 'available';
      const answer = answerByQuestion.get(content.id);
      const entry = projectToolEntry({
        id: `persisted-tool-${content.id}`,
        toolCallId: content.id,
        toolName: content.name,
        argumentsValue: content.arguments,
        resultValue: indexed?.result,
        renderState: indexed?.status === 'failed' ? 'failed' : 'ready',
        confirmation,
        ...(answer ? { answer } : {}),
        ...(indexed?.status === 'failed' ? { error: '这一步没有成功完成。' } : {}),
      });
      if (entry) entries.push(entry);
    });
  });
  return entries;
}
