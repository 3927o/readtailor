/** Composes committed, optimistic, and live facts into one ordered render projection. */

import type { SubmitReadingSetupActionRequest } from '@readtailor/contracts';
import type { ReadingSetupTranscriptEntry } from './types';

export interface ReadingSetupTranscriptSources {
  persisted: readonly ReadingSetupTranscriptEntry[];
  optimistic?: readonly ReadingSetupTranscriptEntry[];
  live?: readonly ReadingSetupTranscriptEntry[];
}

export function projectReadingSetupTranscript({
  persisted,
  optimistic = [],
  live = [],
}: ReadingSetupTranscriptSources): ReadingSetupTranscriptEntry[] {
  return [...persisted, ...optimistic, ...live];
}

export interface OptimisticReadingSetupAction {
  id: string;
  action: SubmitReadingSetupActionRequest;
  delivery: 'sending' | 'sent' | 'failed';
}

function questionDisplayText(
  entry: Extract<ReadingSetupTranscriptEntry, { kind: 'question' }> | undefined,
  action: Extract<SubmitReadingSetupActionRequest, { type: 'question_answer' }>,
): string {
  const labels = entry?.options
    .filter((option) => action.selectedOptionIds.includes(option.id))
    .map((option) => option.label) ?? [];
  return [...labels, action.freeText]
    .filter((value): value is string => Boolean(value))
    .join('。');
}

export function applyOptimisticReadingSetupAction(
  persisted: readonly ReadingSetupTranscriptEntry[],
  optimistic: OptimisticReadingSetupAction | null,
): ReadingSetupTranscriptEntry[] {
  if (!optimistic) return [...persisted];
  const { action, delivery, id } = optimistic;
  if (action.type === 'confirmation') {
    if (delivery === 'failed') return [...persisted];
    return persisted.map((entry) =>
      (
        (entry.kind === 'strategy' || entry.kind === 'trial')
        && entry.toolCallId === action.targetToolCallId
      )
        ? { ...entry, confirmation: 'submitting' }
        : entry);
  }
  if (action.type === 'question_answer') {
    const question = persisted.find(
      (entry): entry is Extract<ReadingSetupTranscriptEntry, { kind: 'question' }> =>
        entry.kind === 'question' && entry.toolCallId === action.questionToolCallId,
    );
    const displayText = questionDisplayText(question, action);
    const userEntry: ReadingSetupTranscriptEntry = {
      id,
      kind: 'user',
      text: displayText,
      delivery,
    };
    return persisted.flatMap((entry): ReadingSetupTranscriptEntry[] => {
      if (entry !== question) return [entry];
      const projectedQuestion: ReadingSetupTranscriptEntry = delivery === 'failed'
        ? entry
        : {
            ...entry,
            answer: {
              selectedOptionIds: [...action.selectedOptionIds],
              freeText: action.freeText,
              displayText,
            },
          };
      return [projectedQuestion, userEntry];
    });
  }
  const text = action.type === 'feedback' ? action.message : action.text;
  return [
    ...persisted,
    {
      id,
      kind: 'user',
      text,
      delivery,
    },
  ];
}
