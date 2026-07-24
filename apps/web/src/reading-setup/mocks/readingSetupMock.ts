/** Supplies fresh, typed fixtures for the mock session source that drives UI/UX acceptance. */

import type { ReadingSetupPageView } from '../session/types';
import type {
  StrategyTranscriptEntry,
  TrialTranscriptEntry,
} from '../transcript/types';

export const MOCK_READING_SETUP_BOOK = {
  id: 'mock-book',
  title: '有限与无限的游戏',
  authors: ['詹姆斯·卡斯'],
} as const;

export const MOCK_READING_STYLE_OPTIONS = [
  { id: 'keep-original', label: '尽量让我先和原文待在一起' },
  { id: 'light-guide', label: '进入段落前给一句轻量提醒' },
  { id: 'key-notes', label: '只在容易误解的地方补一句' },
];

export function createMockStrategyEntry({
  id,
  toolCallId,
  progress,
  revised = false,
}: {
  id: string;
  toolCallId: string;
  progress: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  revised?: boolean;
}): StrategyTranscriptEntry {
  const ready = progress === 6;
  const summary = revised
    ? progress === 0
      ? '我会把解释再收紧一些，只在概念真正转向时'
      : '我会把解释再收紧一些，只在概念真正转向、会影响后文理解的地方出现。'
    : ready || progress > 0
      ? '我会保留原文的推进感，只在关键概念第一次转向时提醒你；读完后，再把它放回你关心的现实选择里。'
      : '我会保留原文的推进感，只在关键概念第一次转向时';
  const strategy = {
    ...(progress >= 1 ? {
      goals: progress === 1
        ? ['看清有限游戏与无限游戏怎样改变行动的意义']
        : [
            '看清有限游戏与无限游戏怎样改变行动的意义',
            '找到这组差异与你长期工作之间真正有关的部分',
          ],
    } : {}),
    ...(progress >= 3 ? {
      guide: {
        enabled: true,
        objectives: ['进入段落前，只提醒这一段正在改变哪个词的含义'],
      },
      annotations: {
        enabled: true,
        focuses: progress === 3
          ? ['概念发生转向的句子']
          : ['概念发生转向的句子', '容易被日常用法带偏的表达'],
      },
    } : {}),
    ...(progress >= 4 ? {
      afterReading: {
        enabled: true,
        objectives: ['把这一段放回你正在做的长期事情里想一想'],
      },
    } : {}),
    ...(progress >= 5 ? {
      expressionPrinciples: progress === 5
        ? ['不把原文改写成结论清单']
        : [
            '不把原文改写成结论清单',
            '作者已经说清楚的地方不重复解释',
          ],
      annotations: {
        enabled: true,
        focuses: ['概念发生转向的句子', '容易被日常用法带偏的表达'],
        exclusions: ['只提供背景、不影响理解的例子'],
      },
    } : {}),
  };
  const streamingSection = progress === 0
    ? 'summary'
    : progress <= 2
      ? 'goals'
      : progress <= 4
        ? 'readingSupport'
        : progress === 5
          ? 'restraint'
          : null;

  return {
    id,
    kind: 'strategy',
    toolCallId,
    renderState: ready ? 'ready' : 'streaming',
    summary,
    strategy,
    ...(streamingSection ? { streamingSection } : {}),
    confirmation: 'available',
  };
}

export function createMockTrialEntry({
  id,
  toolCallId,
  working,
  revised = false,
}: {
  id: string;
  toolCallId: string;
  working: boolean;
  revised?: boolean;
}): TrialTranscriptEntry {
  return {
    id,
    kind: 'trial',
    toolCallId,
    renderState: working ? 'working' : 'ready',
    reason: revised
      ? '按你刚才的提醒，我把导读和裁读注都收紧了一点，换成这一版试试。'
      : '这一小段正好同时出现两种“游戏”，很适合看看这种陪读方式会不会打断你。',
    titlePath: working ? [] : ['第一章', '至少有两种游戏'],
    ...(!working ? {
      guide: revised
        ? '先留意：作者正在把“继续”本身变成目的。'
        : '先不用急着给两种游戏贴上好坏标签，只留意作者如何改变“目的”这个词。',
    } : {}),
    paragraphs: working
      ? []
      : [
          {
            id: `${id}-paragraph-1`,
            segments: [
              { text: '一种游戏以取胜为目标。参与者接受边界、规则和终点，因为只有在这些约定之内，胜负才会成立。' },
            ],
          },
          {
            id: `${id}-paragraph-2`,
            segments: [
              { text: '另一种游戏并不以结束为目的。' },
              {
                text: '参与者改变规则，是为了让更多人还能继续参与。',
                annotationId: `${id}-annotation-1`,
              },
              { text: '它关心的不是谁最后赢了，而是游戏是否仍然开放。' },
            ],
          },
        ],
    annotations: working
      ? []
      : [
          {
            id: `${id}-annotation-1`,
            label: '目的发生了变化',
            content: revised
              ? '这里的重点只是：规则服务于继续，而不是继续服从规则。'
              : '这里不是在反对规则，而是在区分规则究竟服务于一次胜负，还是服务于持续参与。',
          },
        ],
    ...(!working ? {
      afterReading: '你现在正在做的事情里，有没有哪一件看似在追求一次胜负，其实更希望它能长期继续？',
    } : {}),
    confirmation: 'available',
  };
}

export function createInitialMockPage(): ReadingSetupPageView {
  return {
    book: { ...MOCK_READING_SETUP_BOOK, authors: [...MOCK_READING_SETUP_BOOK.authors] },
    connection: 'connected',
    interactionsLocked: false,
    entries: [
      {
        id: 'mock-opening',
        kind: 'assistant',
        text: '我先看了目录和几个关键段落。这本书不算长，但它会悄悄换掉一些我们很熟悉的词，所以开始前，我想先知道你为什么选了它。',
        streaming: false,
      },
      {
        id: 'mock-question-purpose',
        kind: 'question',
        toolCallId: 'mock-question-purpose-call',
        renderState: 'ready',
        prompt: '读完以后，你更希望它在哪件事上帮到你？',
        options: [
          { id: 'purpose-work', label: '重新理解自己正在做的长期工作' },
        ],
        allowFreeText: true,
        answer: {
          selectedOptionIds: ['purpose-work'],
          freeText: null,
          displayText: '重新理解自己正在做的长期工作',
        },
      },
      {
        id: 'mock-answer-purpose',
        kind: 'user',
        text: '重新理解自己正在做的长期工作',
        delivery: 'sent',
      },
      {
        id: 'mock-follow-up',
        kind: 'assistant',
        text: '明白。那我不会只把它讲成',
        streaming: true,
      },
      {
        id: 'mock-question-reading-style',
        kind: 'question',
        toolCallId: 'mock-question-reading-style-call',
        renderState: 'streaming',
        prompt: '遇到比较抽象的段落时，',
        options: [],
        streamingPart: 'prompt',
      },
    ],
  };
}

export const MOCK_READING_SETUP_PAGE = createInitialMockPage();
