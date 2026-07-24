/** Simulates authoritative session facts for UI acceptance and is replaced wholesale by the API adapter. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AnswerQuestionCommand,
  ReadingSetupCommands,
  ReadingSetupController,
  SendFeedbackCommand,
} from '../session/types';
import type { ReadingSetupConnection } from '../session/runConnection';
import type {
  BriefTranscriptEntry,
  ReadingSetupTranscriptEntry,
  StrategyTranscriptEntry,
  TrialTranscriptEntry,
} from '../transcript/types';
import {
  createInitialMockPage,
  createMockStrategyEntry,
  createMockTrialEntry,
  MOCK_READING_STYLE_OPTIONS,
} from './readingSetupMock';

type EntryUpdater = (
  current: ReadingSetupTranscriptEntry[],
) => ReadingSetupTranscriptEntry[];

const MOCK_STREAM_DELAY_SCALE = 1.6;

function updateEntry(
  entries: ReadingSetupTranscriptEntry[],
  id: string,
  update: (entry: ReadingSetupTranscriptEntry) => ReadingSetupTranscriptEntry,
) {
  return entries.map((entry) => entry.id === id ? update(entry) : entry);
}

function appendUnique(
  entries: ReadingSetupTranscriptEntry[],
  additions: ReadingSetupTranscriptEntry[],
) {
  const ids = new Set(additions.map((entry) => entry.id));
  return [...entries.filter((entry) => !ids.has(entry.id)), ...additions];
}

export function useReadingSetupMockSource(): ReadingSetupController {
  const initialPage = useMemo(createInitialMockPage, []);
  const [entries, setEntries] = useState(initialPage.entries);
  const entriesRef = useRef(entries);
  const [connection, setConnection] = useState<ReadingSetupConnection>('connected');
  const [runBusy, setRunBusy] = useState(true);
  const runBusyRef = useRef(true);
  const sequence = useRef(0);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const commit = useCallback((updater: EntryUpdater) => {
    const next = updater(entriesRef.current);
    entriesRef.current = next;
    setEntries(next);
  }, []);

  const setBusy = useCallback((busy: boolean) => {
    runBusyRef.current = busy;
    setRunBusy(busy);
  }, []);

  const schedule = useCallback((delay: number, task: () => void) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      task();
    }, delay);
    timers.current.add(timer);
  }, []);

  const scheduleStream = useCallback((delay: number, task: () => void) => {
    schedule(Math.round(delay * MOCK_STREAM_DELAY_SCALE), task);
  }, [schedule]);

  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
  }, []);

  useEffect(() => {
    scheduleStream(300, () => {
      commit((current) => updateEntry(current, 'mock-follow-up', (entry) => (
        entry.kind === 'assistant'
          ? { ...entry, text: '明白。那我不会只把它讲成一套有趣的概念，' }
          : entry
      )));
    });
    scheduleStream(680, () => {
      commit((current) => updateEntry(
        updateEntry(current, 'mock-follow-up', (entry) => (
          entry.kind === 'assistant'
            ? {
                ...entry,
                text: '明白。那我不会只把它讲成一套有趣的概念，而会留意它怎么碰到你真实的选择。',
              }
            : entry
        )),
        'mock-question-reading-style',
        (entry) => entry.kind === 'question'
          ? { ...entry, prompt: '遇到比较抽象的段落时，你希望我' }
          : entry,
      ));
    });
    scheduleStream(1_060, () => {
      commit((current) => updateEntry(
        updateEntry(current, 'mock-follow-up', (entry) => (
          entry.kind === 'assistant'
            ? {
                ...entry,
                text: '明白。那我不会只把它讲成一套有趣的概念，而会留意它怎么碰到你真实的选择。还有一个小问题。',
                streaming: false,
              }
            : entry
        )),
        'mock-question-reading-style',
        (entry) => entry.kind === 'question'
          ? {
              ...entry,
              prompt: '遇到比较抽象的段落时，你希望我怎么陪你？',
              options: MOCK_READING_STYLE_OPTIONS.slice(0, 1),
              streamingPart: 'options',
            }
          : entry,
      ));
    });
    scheduleStream(1_300, () => {
      commit((current) => updateEntry(
        current,
        'mock-question-reading-style',
        (entry) => entry.kind === 'question'
          ? {
              ...entry,
              hint: '选一个最接近的，',
              streamingPart: 'hint',
            }
          : entry,
      ));
    });
    scheduleStream(1_520, () => {
      commit((current) => updateEntry(
        current,
        'mock-question-reading-style',
        (entry) => entry.kind === 'question'
          ? {
              ...entry,
              hint: '选一个最接近的，也可以直接说自己的习惯。',
              options: MOCK_READING_STYLE_OPTIONS.slice(0, 2),
              allowFreeText: true,
              streamingPart: 'options',
            }
          : entry,
      ));
    });
    scheduleStream(1_900, () => {
      commit((current) => updateEntry(
        current,
        'mock-question-reading-style',
        (entry) => entry.kind === 'question'
          ? (() => {
              const readyEntry = {
                ...entry,
                renderState: 'ready' as const,
                options: [...MOCK_READING_STYLE_OPTIONS],
              };
              delete readyEntry.streamingPart;
              return readyEntry;
            })()
          : entry,
      ));
      setBusy(false);
    });
  }, [commit, scheduleStream, setBusy]);

  const answerQuestion = useCallback((input: AnswerQuestionCommand) => {
    if (runBusyRef.current) return;
    const question = entriesRef.current.find(
      (entry) => entry.kind === 'question' && entry.toolCallId === input.toolCallId,
    );
    if (!question || question.kind !== 'question' || question.answer) return;

    const selectedLabels = question.options
      .filter((option) => input.selectedOptionIds.includes(option.id))
      .map((option) => option.label);
    const displayText = [...selectedLabels, input.freeText]
      .filter((value): value is string => Boolean(value))
      .join('。');
    if (!displayText) return;

    const answerId = `mock-answer-${question.toolCallId}`;
    commit((current) => current.flatMap((entry) => (
      entry.id === question.id
        ? [
            {
              ...question,
              answer: {
                selectedOptionIds: input.selectedOptionIds,
                freeText: input.freeText,
                displayText,
              },
            },
            {
              id: answerId,
              kind: 'user' as const,
              text: displayText,
              delivery: 'sending' as const,
            },
          ]
        : [entry]
    )));
    setBusy(true);

    schedule(240, () => {
      commit((current) => updateEntry(current, answerId, (entry) => (
        entry.kind === 'user' ? { ...entry, delivery: 'sent' } : entry
      )));
    });

    scheduleStream(360, () => {
      commit((current) => appendUnique(current, [
        {
          id: 'mock-analysis',
          kind: 'assistant',
          text: '好，我会让提醒尽量轻一点。现在我去书里核对几处关键地方，',
          streaming: true,
        },
        {
          id: 'mock-query',
          kind: 'query',
          toolCallId: 'mock-search-book',
          renderState: 'working',
          activity: '正在核对作者反复使用的几个核心概念',
        },
        {
          id: 'mock-profile',
          kind: 'profile',
          toolCallId: 'mock-publish-profile',
          renderState: 'streaming',
        },
      ]));
    });

    scheduleStream(720, () => {
      commit((current) => appendUnique(
        updateEntry(current, 'mock-analysis', (entry) => (
          entry.kind === 'assistant'
            ? {
                ...entry,
                text: '好，我会让提醒尽量轻一点。现在我去书里核对几处关键地方，再给你一张真正能带进阅读里的小地图。',
              }
            : entry
        )),
        [
          {
            id: 'mock-brief',
            kind: 'brief',
            toolCallId: 'mock-publish-brief',
            renderState: 'streaming',
            brief: {
              bookIdentity: '这是一本借“游戏”讨论选择、边界与',
            },
            streamingField: 'bookIdentity',
          },
        ],
      ));
    });

    scheduleStream(950, () => {
      commit((current) => updateEntry(
        updateEntry(current, 'mock-analysis', (entry) => (
          entry.kind === 'assistant' ? { ...entry, streaming: false } : entry
        )),
        'mock-brief',
        (entry) => entry.kind === 'brief'
          ? {
              ...entry,
              brief: {
                ...entry.brief,
                bookIdentity: '这是一本借“游戏”讨论选择、边界与行动意义的思想随笔。',
              },
            }
          : entry,
      ));
    });

    scheduleStream(1_220, () => {
      commit((current) => updateEntry(current, 'mock-brief', (entry) => (
        entry.kind === 'brief'
          ? {
              ...entry,
              streamingField: 'arc',
              brief: {
                ...entry.brief,
                arc: '全书先区分有限游戏与无限游戏，',
              },
            }
          : entry
      )));
    });

    scheduleStream(1_490, () => {
      commit((current) => updateEntry(current, 'mock-brief', (entry) => (
        entry.kind === 'brief'
          ? {
              ...entry,
              brief: {
                ...entry.brief,
                arc: '全书先区分有限游戏与无限游戏，再把这组差异推向权力、社会、语言和自我。',
              },
            }
          : entry
      )));
    });

    scheduleStream(1_760, () => {
      commit((current) => updateEntry(current, 'mock-brief', (entry) => (
        entry.kind === 'brief'
          ? {
              ...entry,
              streamingField: 'assumedKnowledge',
              brief: {
                ...entry.brief,
                assumedKnowledge: '不需要先懂博弈论；这里的“游戏”',
              },
            }
          : entry
      )));
    });

    scheduleStream(2_030, () => {
      commit((current) => updateEntry(current, 'mock-brief', (entry) => (
        entry.kind === 'brief'
          ? {
              ...entry,
              brief: {
                ...entry.brief,
                assumedKnowledge: '不需要先懂博弈论；这里的“游戏”更接近一种看待行动的方式。',
              },
            }
          : entry
      )));
    });

    scheduleStream(2_300, () => {
      commit((current) => updateEntry(current, 'mock-brief', (entry) => (
        entry.kind === 'brief'
          ? {
              ...entry,
              streamingField: 'readingAdvice',
              brief: {
                ...entry.brief,
                readingAdvice: '先让原文完整走一遍；我只在概念发生转向时',
              },
            }
          : entry
      )));
    });

    scheduleStream(2_570, () => {
      const strategy = createMockStrategyEntry({
        id: 'mock-strategy',
        toolCallId: 'mock-publish-strategy',
        progress: 0,
      });
      commit((current) => appendUnique(
        updateEntry(
          updateEntry(
            current.filter((entry) => entry.id !== 'mock-query'),
            'mock-analysis',
            (entry) => entry.kind === 'assistant'
              ? { ...entry, streaming: false }
              : entry,
          ),
          'mock-brief',
          (entry) => entry.kind === 'brief'
            ? (() => {
                const readyEntry: BriefTranscriptEntry = {
                  ...entry,
                  renderState: 'ready',
                  brief: {
                    ...entry.brief,
                    readingAdvice: '先让原文完整走一遍；我只在概念发生转向时出现，读完后再陪你把它放回长期工作。',
                  },
                };
                delete readyEntry.streamingField;
                return readyEntry;
              })()
            : entry,
        ),
        [
          {
            id: 'mock-strategy-intro',
            kind: 'assistant',
            text: '地图差不多了。结合你刚才说的阅读习惯，我想这样陪你读：',
            streaming: true,
          },
          strategy,
        ],
      ).map((entry) => entry.id === 'mock-profile' && entry.kind === 'profile'
        ? { ...entry, renderState: 'ready' as const }
        : entry));
    });

    scheduleStream(2_870, () => {
      const strategy = createMockStrategyEntry({
        id: 'mock-strategy',
        toolCallId: 'mock-publish-strategy',
        progress: 1,
      });
      commit((current) => updateEntry(
        updateEntry(current, 'mock-strategy-intro', (entry) => (
          entry.kind === 'assistant'
            ? {
                ...entry,
                text: '地图差不多了。结合你刚才说的阅读习惯，我想这样陪你读：',
              }
            : entry
        )),
        'mock-strategy',
        () => strategy,
      ));
    });

    scheduleStream(3_070, () => {
      commit((current) => updateEntry(
        current,
        'mock-strategy',
        () => createMockStrategyEntry({
          id: 'mock-strategy',
          toolCallId: 'mock-publish-strategy',
          progress: 2,
        }),
      ));
    });

    scheduleStream(3_270, () => {
      commit((current) => updateEntry(
        current,
        'mock-strategy',
        () => createMockStrategyEntry({
          id: 'mock-strategy',
          toolCallId: 'mock-publish-strategy',
          progress: 3,
        }),
      ));
    });

    scheduleStream(3_470, () => {
      commit((current) => updateEntry(
        current,
        'mock-strategy',
        () => createMockStrategyEntry({
          id: 'mock-strategy',
          toolCallId: 'mock-publish-strategy',
          progress: 4,
        }),
      ));
    });

    scheduleStream(3_670, () => {
      commit((current) => updateEntry(
        current,
        'mock-strategy',
        () => createMockStrategyEntry({
          id: 'mock-strategy',
          toolCallId: 'mock-publish-strategy',
          progress: 5,
        }),
      ));
    });

    scheduleStream(3_970, () => {
      const strategy = createMockStrategyEntry({
        id: 'mock-strategy',
        toolCallId: 'mock-publish-strategy',
        progress: 6,
      });
      commit((current) => updateEntry(
        updateEntry(current, 'mock-strategy-intro', (entry) => (
          entry.kind === 'assistant' ? { ...entry, streaming: false } : entry
        )),
        'mock-strategy',
        () => strategy,
      ));
      setBusy(false);
    });
  }, [commit, schedule, scheduleStream, setBusy]);

  const sendFeedback = useCallback((input: SendFeedbackCommand) => {
    if (runBusyRef.current) return;
    const target = entriesRef.current.find(
      (entry) => 'toolCallId' in entry && entry.toolCallId === input.targetToolCallId,
    );
    if (
      !target
      || (target.kind !== 'strategy' && target.kind !== 'trial')
      || target.renderState !== 'ready'
      || target.confirmation !== 'available'
    ) return;

    sequence.current += 1;
    const revision = sequence.current;
    const userId = `mock-feedback-${revision}`;
    const responseId = `mock-feedback-response-${revision}`;
    const revisedId = `mock-${target.kind}-revision-${revision}`;
    const revisedToolCallId = `${revisedId}-call`;

    commit((current) => [
      ...current,
      {
        id: userId,
        kind: 'user',
        text: input.message,
        delivery: 'sending',
      },
    ]);
    setBusy(true);

    schedule(220, () => {
      commit((current) => updateEntry(current, userId, (entry) => (
        entry.kind === 'user' ? { ...entry, delivery: 'sent' } : entry
      )));
    });

    scheduleStream(360, () => {
      commit((current) => appendUnique(current, [
        {
          id: responseId,
          kind: 'assistant',
          text: target.kind === 'strategy'
            ? '嗯，我明白。不是增加更多说明，而是让我出现得更克制一点。'
            : '明白，这段真正需要的是更少的打断。我把导读和裁读注一起收紧。',
          streaming: true,
        },
      ]));
    });

    scheduleStream(680, () => {
      const revisedEntry = target.kind === 'strategy'
        ? createMockStrategyEntry({
            id: revisedId,
            toolCallId: revisedToolCallId,
            progress: 0,
            revised: true,
          })
        : createMockTrialEntry({
            id: revisedId,
            toolCallId: revisedToolCallId,
            working: true,
            revised: true,
          });
      commit((current) => appendUnique(current, [revisedEntry]));
    });

    scheduleStream(980, () => {
      if (target.kind !== 'strategy') return;
      commit((current) => updateEntry(
        current,
        revisedId,
        () => createMockStrategyEntry({
          id: revisedId,
          toolCallId: revisedToolCallId,
          progress: 2,
          revised: true,
        }),
      ));
    });

    scheduleStream(1_300, () => {
      if (target.kind !== 'strategy') return;
      commit((current) => updateEntry(
        current,
        revisedId,
        () => createMockStrategyEntry({
          id: revisedId,
          toolCallId: revisedToolCallId,
          progress: 4,
          revised: true,
        }),
      ));
    });

    scheduleStream(1_600, () => {
      if (target.kind !== 'strategy') return;
      commit((current) => updateEntry(
        current,
        revisedId,
        () => createMockStrategyEntry({
          id: revisedId,
          toolCallId: revisedToolCallId,
          progress: 5,
          revised: true,
        }),
      ));
    });

    scheduleStream(1_900, () => {
      const revisedEntry = target.kind === 'strategy'
        ? createMockStrategyEntry({
            id: revisedId,
            toolCallId: revisedToolCallId,
            progress: 6,
            revised: true,
          })
        : createMockTrialEntry({
            id: revisedId,
            toolCallId: revisedToolCallId,
            working: false,
            revised: true,
          });
      commit((current) => updateEntry(
        updateEntry(
          updateEntry(current, target.id, (entry) => (
            entry.kind === target.kind
              ? { ...entry, confirmation: 'superseded' }
              : entry
          )),
          responseId,
          (entry) => entry.kind === 'assistant'
            ? { ...entry, streaming: false }
            : entry,
        ),
        revisedId,
        () => revisedEntry,
      ));
      setBusy(false);
    });
  }, [commit, schedule, scheduleStream, setBusy]);

  const confirmStrategy = useCallback((toolCallId: string) => {
    if (runBusyRef.current) return;
    const strategy = entriesRef.current.find(
      (entry): entry is StrategyTranscriptEntry => (
        entry.kind === 'strategy'
        && entry.toolCallId === toolCallId
        && entry.renderState === 'ready'
        && entry.confirmation === 'available'
      ),
    );
    if (!strategy) return;

    sequence.current += 1;
    const trialId = `mock-trial-${sequence.current}`;
    const trialToolCallId = `${trialId}-call`;
    const responseId = `mock-strategy-confirmed-${sequence.current}`;
    commit((current) => updateEntry(current, strategy.id, (entry) => (
      entry.kind === 'strategy' ? { ...entry, confirmation: 'submitting' } : entry
    )));
    setBusy(true);

    scheduleStream(320, () => {
      commit((current) => appendUnique(
        updateEntry(current, strategy.id, (entry) => (
          entry.kind === 'strategy' ? { ...entry, confirmation: 'completed' } : entry
        )),
        [
          {
            id: responseId,
            kind: 'assistant',
            text: '好，就按这个来。我挑一小段，我们先感受一下实际读起来是什么样子。',
            streaming: true,
          },
          createMockTrialEntry({
            id: trialId,
            toolCallId: trialToolCallId,
            working: true,
          }),
        ],
      ));
    });

    scheduleStream(1_180, () => {
      const trial = createMockTrialEntry({
        id: trialId,
        toolCallId: trialToolCallId,
        working: false,
      });
      commit((current) => updateEntry(
        updateEntry(current, responseId, (entry) => (
          entry.kind === 'assistant' ? { ...entry, streaming: false } : entry
        )),
        trialId,
        () => trial,
      ));
      setBusy(false);
    });
  }, [commit, scheduleStream, setBusy]);

  const confirmTrial = useCallback((toolCallId: string) => {
    if (runBusyRef.current) return;
    const trial = entriesRef.current.find(
      (entry): entry is TrialTranscriptEntry => (
        entry.kind === 'trial'
        && entry.toolCallId === toolCallId
        && entry.renderState === 'ready'
        && entry.confirmation === 'available'
      ),
    );
    if (!trial) return;

    commit((current) => updateEntry(current, trial.id, (entry) => (
      entry.kind === 'trial' ? { ...entry, confirmation: 'submitting' } : entry
    )));
    setBusy(true);
    schedule(620, () => {
      commit((current) => updateEntry(current, trial.id, (entry) => (
        entry.kind === 'trial' ? { ...entry, confirmation: 'completed' } : entry
      )));
      setBusy(false);
    });
  }, [commit, schedule, setBusy]);

  const retryConnection = useCallback(() => {
    setConnection('connecting');
    schedule(520, () => {
      setConnection('connected');
      commit((current) => current.filter((entry) => entry.kind !== 'notice'));
    });
  }, [commit, schedule]);

  const commands = useMemo<ReadingSetupCommands>(() => ({
    answerQuestion,
    sendFeedback,
    confirmStrategy,
    confirmTrial,
    retryConnection,
  }), [
    answerQuestion,
    confirmStrategy,
    confirmTrial,
    retryConnection,
    sendFeedback,
  ]);

  return {
    view: {
      ...initialPage,
      entries,
      connection,
      interactionsLocked: runBusy,
    },
    commands,
  };
}
