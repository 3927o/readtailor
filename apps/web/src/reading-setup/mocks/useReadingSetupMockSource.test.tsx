// @vitest-environment happy-dom
/** Verifies that the UI-only mock emits conversation facts without a frontend workflow stage. */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadingSetupController } from '../session/types';
import { MOCK_READING_STYLE_OPTIONS } from './readingSetupMock';
import { useReadingSetupMockSource } from './useReadingSetupMockSource';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latestController: ReadingSetupController | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function controller(): ReadingSetupController {
  if (!latestController) throw new Error('mock controller has not rendered');
  return latestController;
}

function Harness() {
  latestController = useReadingSetupMockSource();
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  latestController = null;
  root = createRoot(document.createElement('div'));
  act(() => root?.render(<Harness />));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latestController = null;
  vi.useRealTimers();
});

describe('useReadingSetupMockSource', () => {
  it('emits the full answer, preparation, revision, strategy, and trial fact sequence', async () => {
    expect(controller().view.interactionsLocked).toBe(true);
    expect(controller().view.entries.at(-1)).toMatchObject({
      kind: 'question',
      renderState: 'streaming',
      options: [],
    });

    await act(async () => vi.advanceTimersByTimeAsync(1_800));

    expect(controller().view.interactionsLocked).toBe(true);
    expect(controller().view.entries.at(-1)).toMatchObject({
      kind: 'question',
      renderState: 'streaming',
      options: MOCK_READING_STYLE_OPTIONS.slice(0, 1),
    });

    await act(async () => vi.advanceTimersByTimeAsync(1_300));

    expect(controller().view.interactionsLocked).toBe(false);
    expect(controller().view.entries.at(-1)).toMatchObject({
      kind: 'question',
      renderState: 'ready',
      options: MOCK_READING_STYLE_OPTIONS,
    });

    act(() => {
      controller().commands.answerQuestion({
        toolCallId: 'mock-question-reading-style-call',
        selectedOptionIds: ['light-guide'],
        freeText: null,
      });
    });

    expect(controller().view.interactionsLocked).toBe(true);
    expect(controller().view.entries.at(-1)).toMatchObject({
      kind: 'user',
      delivery: 'sending',
    });

    await act(async () => vi.advanceTimersByTimeAsync(1_200));

    expect(controller().view.entries.find((entry) => entry.kind === 'brief'))
      .toMatchObject({
        renderState: 'streaming',
        streamingField: 'bookIdentity',
      });

    await act(async () => vi.advanceTimersByTimeAsync(800));

    expect(controller().view.entries.find((entry) => entry.kind === 'brief'))
      .toMatchObject({
        renderState: 'streaming',
        streamingField: 'arc',
      });

    await act(async () => vi.advanceTimersByTimeAsync(2_200));

    expect(controller().view.entries.find((entry) => entry.kind === 'brief'))
      .toMatchObject({ renderState: 'ready' });
    expect(controller().view.entries.find((entry) => entry.kind === 'strategy'))
      .toMatchObject({
        renderState: 'streaming',
        streamingSection: 'summary',
      });

    await act(async () => vi.advanceTimersByTimeAsync(750));

    expect(controller().view.entries.find((entry) => entry.kind === 'strategy'))
      .toMatchObject({
        streamingSection: 'goals',
        strategy: { goals: expect.arrayContaining([
          '看清有限游戏与无限游戏怎样改变行动的意义',
          '找到这组差异与你长期工作之间真正有关的部分',
        ]) },
      });

    await act(async () => vi.advanceTimersByTimeAsync(650));

    expect(controller().view.entries.find((entry) => entry.kind === 'strategy'))
      .toMatchObject({ streamingSection: 'readingSupport' });

    await act(async () => vi.advanceTimersByTimeAsync(800));

    expect(controller().view.interactionsLocked).toBe(false);
    expect(controller().view.entries.some((entry) => entry.kind === 'query')).toBe(false);
    expect(controller().view.entries.find((entry) => entry.kind === 'brief'))
      .toMatchObject({ renderState: 'ready' });
    const firstStrategy = controller().view.entries.find(
      (entry) => entry.kind === 'strategy',
    );
    expect(firstStrategy).toMatchObject({
      renderState: 'ready',
      confirmation: 'available',
    });

    act(() => {
      if (!firstStrategy || firstStrategy.kind !== 'strategy') return;
      controller().commands.sendFeedback({
        targetToolCallId: firstStrategy.toolCallId,
        message: '解释再少一点。',
      });
    });
    await act(async () => vi.advanceTimersByTimeAsync(3_100));

    expect(controller().view.entries.find((entry) => entry.id === firstStrategy?.id))
      .toMatchObject({ confirmation: 'superseded' });
    const currentStrategy = controller().view.entries
      .filter((entry): entry is Extract<typeof entry, { kind: 'strategy' }> => (
        entry.kind === 'strategy'
      ))
      .at(-1);
    expect(currentStrategy).toMatchObject({
      renderState: 'ready',
      confirmation: 'available',
    });

    act(() => {
      if (currentStrategy) {
        controller().commands.confirmStrategy(currentStrategy.toolCallId);
      }
    });
    expect(controller().view.entries.find((entry) => entry.id === currentStrategy?.id))
      .toMatchObject({ confirmation: 'submitting' });

    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(controller().view.entries
      .filter((entry) => entry.kind === 'trial')
      .at(-1))
      .toMatchObject({ renderState: 'working' });

    await act(async () => vi.advanceTimersByTimeAsync(950));

    expect(controller().view.entries.find((entry) => entry.id === currentStrategy?.id))
      .toMatchObject({ confirmation: 'completed' });
    const trial = controller().view.entries
      .filter((entry): entry is Extract<typeof entry, { kind: 'trial' }> => (
        entry.kind === 'trial'
      ))
      .at(-1);
    expect(trial).toMatchObject({
      renderState: 'ready',
      confirmation: 'available',
    });

    act(() => {
      if (trial) controller().commands.confirmTrial(trial.toolCallId);
    });
    await act(async () => vi.advanceTimersByTimeAsync(650));

    expect(controller().view.entries.find((entry) => entry.id === trial?.id))
      .toMatchObject({ confirmation: 'completed' });
    expect(controller().view.entries.filter((entry) => entry.kind === 'user'))
      .toHaveLength(3);
  });
});
