// @vitest-environment happy-dom
/** Verifies the second component batch's visibility, feedback, confirmation, and trial interactions. */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadingSetupCommands } from '../session/types';
import type {
  ReadingSetupTranscriptEntry,
  StrategyTranscriptEntry,
  TrialTranscriptEntry,
} from '../transcript/types';
import { ReadingSetupTranscript } from './ReadingSetupTranscript';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<ReturnType<typeof createRoot>> = [];

function commands(
  overrides: Partial<ReadingSetupCommands> = {},
): ReadingSetupCommands {
  return {
    answerQuestion: vi.fn(),
    sendFeedback: vi.fn(),
    confirmStrategy: vi.fn(),
    confirmTrial: vi.fn(),
    retryConnection: vi.fn(),
    ...overrides,
  };
}

function mount(content: React.ReactNode) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(content));
  return { container, root };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    ?.set?.call(textarea, value);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
}

function submitForm(form: HTMLFormElement) {
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
}

const strategyEntry: StrategyTranscriptEntry = {
  id: 'strategy',
  kind: 'strategy',
  toolCallId: 'strategy-call',
  renderState: 'ready',
  summary: '保留原文的推进感，只在关键概念第一次转向时提醒你。',
  strategy: {
    goals: ['看清有限游戏和无限游戏如何改变行动的意义'],
    expressionPrinciples: ['不把原文改写成结论清单'],
    guide: {
      enabled: true,
      objectives: ['先知道这一段正在改变哪个词的含义'],
    },
    annotations: {
      enabled: true,
      focuses: ['概念发生转向的句子'],
      exclusions: ['作者已经说得足够清楚的例子'],
    },
  },
  confirmation: 'available',
};

const trialEntry: TrialTranscriptEntry = {
  id: 'trial',
  kind: 'trial',
  toolCallId: 'trial-call',
  renderState: 'ready',
  reason: '这一段很短，但能直接看出这次阅读方式会不会打断你。',
  titlePath: ['第一章', '至少有两种游戏'],
  guide: '先留意作者如何从 **规则** 谈到参与者为什么继续。',
  paragraphs: [
    {
      id: 'paragraph-1',
      segments: [
        { text: '有限游戏为了取胜，' },
        { text: '无限游戏为了让游戏继续。', annotationId: 'annotation-1' },
      ],
    },
  ],
  annotations: [
    {
      id: 'annotation-1',
      label: '概念转向',
      content: '这里把目标从一次胜负换成了 **关系能否持续**。',
    },
  ],
  afterReading: '- 你现在更在意赢下哪一局？\n- 还是什么事情能继续？',
  confirmation: 'available',
};

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

describe('ReadingSetupTranscript artifact entries', () => {
  it('keeps query activity transient, hides profile, and gives Brief no feedback affordance', () => {
    const entries: ReadingSetupTranscriptEntry[] = [
      {
        id: 'active-query',
        kind: 'query',
        toolCallId: 'active-query-call',
        renderState: 'working',
        activity: '正在核对全书反复出现的几个概念',
      },
      {
        id: 'failed-query',
        kind: 'query',
        toolCallId: 'failed-query-call',
        renderState: 'failed',
        activity: '不应残留的查询',
      },
      {
        id: 'profile',
        kind: 'profile',
        toolCallId: 'profile-call',
        renderState: 'ready',
      },
      {
        id: 'brief',
        kind: 'brief',
        toolCallId: 'brief-call',
        renderState: 'ready',
        brief: {
          bookIdentity: '这是一本讨论选择、边界与行动意义的思想随笔。',
          arc: '全书从两种游戏出发，逐步谈到社会与自我。',
        },
      },
    ];

    const html = renderToStaticMarkup(
      <ReadingSetupTranscript entries={entries} commands={commands()} />,
    );

    expect(html).toContain('正在核对全书反复出现的几个概念');
    expect(html).not.toContain('不应残留的查询');
    expect(html).not.toContain('profile-call');
    expect(html).toContain('这是一本讨论选择、边界与行动意义的思想随笔');
    expect(html).not.toContain('rss-feedback-trigger');
  });

  it('keeps one Brief component stable while partial fields stream into it', () => {
    const entry: ReadingSetupTranscriptEntry = {
      id: 'streaming-brief',
      kind: 'brief',
      toolCallId: 'streaming-brief-call',
      renderState: 'streaming',
      brief: {
        bookIdentity: '这是一本正在讨论选择的',
      },
    };
    const html = renderToStaticMarkup(
      <ReadingSetupTranscript entries={[entry]} commands={commands()} />,
    );

    expect(html.match(/rss-brief-entry/g)).toHaveLength(1);
    expect(html.match(/rss-brief-section/g)).toHaveLength(1);
    expect(html).not.toContain('全书怎么走');
    expect(html).toContain('rss-stream-cursor');
    expect(html).toContain('data-state="streaming"');
  });

  it('infers the active Strategy section when the transport provides only partial props', () => {
    const entry: StrategyTranscriptEntry = {
      id: 'inferred-strategy',
      kind: 'strategy',
      toolCallId: 'inferred-strategy-call',
      renderState: 'streaming',
      summary: '我会保留原文的推进感。',
      strategy: {
        goals: ['看清两种游戏如何改变行动的意义'],
      },
      confirmation: 'available',
    };
    const html = renderToStaticMarkup(
      <ReadingSetupTranscript entries={[entry]} commands={commands()} />,
    );

    expect(html).toContain('这次阅读要带走什么');
    expect(html).not.toContain('阅读时我会做什么');
    expect(html).toContain('rss-stream-cursor');
  });

  it('grows Brief fields and Strategy sections without replacing their component shells', () => {
    const brief: ReadingSetupTranscriptEntry = {
      id: 'progressive-brief',
      kind: 'brief',
      toolCallId: 'progressive-brief-call',
      renderState: 'streaming',
      streamingField: 'bookIdentity',
      brief: {
        bookIdentity: '这是一本讨论选择与',
      },
    };
    const strategy: StrategyTranscriptEntry = {
      id: 'progressive-strategy',
      kind: 'strategy',
      toolCallId: 'progressive-strategy-call',
      renderState: 'streaming',
      streamingSection: 'summary',
      summary: '我会保留原文，只在',
      strategy: {},
      confirmation: 'available',
    };
    const componentCommands = commands();
    const { container, root } = mount(
      <ReadingSetupTranscript
        entries={[brief, strategy]}
        commands={componentCommands}
      />,
    );
    const briefShell = container.querySelector('.rss-brief-entry');
    const strategyShell = container.querySelector('.rss-strategy-entry');
    const firstBriefSection = container.querySelector('.rss-brief-section');
    expect(container.querySelectorAll('.rss-brief-section')).toHaveLength(1);
    expect(container.querySelectorAll('.rss-strategy-section')).toHaveLength(0);

    act(() => root.render(
      <ReadingSetupTranscript
        entries={[
          {
            ...brief,
            streamingField: 'arc',
            brief: {
              bookIdentity: '这是一本讨论选择与行动意义的思想随笔。',
              arc: '全书先区分两种游戏，',
            },
          },
          {
            ...strategy,
            streamingSection: 'goals',
            summary: '我会保留原文，只在关键概念转向时提醒你。',
            strategy: {
              goals: ['看清两种游戏如何改变行动的意义'],
            },
          },
        ]}
        commands={componentCommands}
      />,
    ));

    expect(container.querySelector('.rss-brief-entry')).toBe(briefShell);
    expect(container.querySelector('.rss-strategy-entry')).toBe(strategyShell);
    expect(container.querySelector('.rss-brief-section')).toBe(firstBriefSection);
    expect(container.querySelectorAll('.rss-brief-section')).toHaveLength(2);
    expect(container.querySelectorAll('.rss-strategy-section')).toHaveLength(1);
    const firstGoal = container.querySelector('.rss-strategy-section li');

    act(() => root.render(
      <ReadingSetupTranscript
        entries={[
          {
            ...brief,
            streamingField: 'arc',
            brief: {
              bookIdentity: '这是一本讨论选择与行动意义的思想随笔。',
              arc: '全书先区分两种游戏，再把差异推向',
            },
          },
          {
            ...strategy,
            streamingSection: 'goals',
            summary: '我会保留原文，只在关键概念转向时提醒你。',
            strategy: {
              goals: [
                '看清两种游戏如何改变行动的意义',
                '找到它与你长期工作真正有关的部分',
              ],
            },
          },
        ]}
        commands={componentCommands}
      />,
    ));

    expect(container.querySelector('.rss-brief-section')).toBe(firstBriefSection);
    expect(container.querySelector('.rss-strategy-section li')).toBe(firstGoal);
    expect(container.querySelectorAll('.rss-strategy-section li')).toHaveLength(2);

    act(() => root.render(
      <ReadingSetupTranscript
        entries={[
          {
            ...brief,
            streamingField: 'assumedKnowledge',
            brief: {
              bookIdentity: '这是一本讨论选择与行动意义的思想随笔。',
              arc: '全书先区分两种游戏，再把差异推向社会与自我。',
              assumedKnowledge: '不需要先懂博弈论，',
            },
          },
          {
            ...strategy,
            streamingSection: 'readingSupport',
            summary: '我会保留原文，只在关键概念转向时提醒你。',
            strategy: {
              goals: ['看清两种游戏如何改变行动的意义'],
              guide: {
                enabled: true,
                objectives: ['进入段落前给一句轻量提醒'],
              },
            },
          },
        ]}
        commands={componentCommands}
      />,
    ));

    expect(container.querySelector('.rss-brief-entry')).toBe(briefShell);
    expect(container.querySelector('.rss-strategy-entry')).toBe(strategyShell);
    expect(container.querySelector('.rss-brief-section')).toBe(firstBriefSection);
    expect(container.querySelectorAll('.rss-brief-section')).toHaveLength(3);
    expect(container.querySelectorAll('.rss-strategy-section')).toHaveLength(2);
  });

  it('submits Strategy feedback inline and confirms through separate commands', async () => {
    const sendFeedback = vi.fn().mockResolvedValue(undefined);
    const confirmStrategy = vi.fn().mockResolvedValue(undefined);
    const componentCommands = commands({ sendFeedback, confirmStrategy });
    const { container } = mount(
      <ReadingSetupTranscript
        entries={[strategyEntry]}
        commands={componentCommands}
      />,
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.rss-feedback-trigger')!.click();
    });
    const textarea = container.querySelector<HTMLTextAreaElement>(
      '.rss-feedback-form textarea',
    )!;
    await act(async () => setTextareaValue(
      textarea,
      '  少解释一点，我想多保留自己的判断。  ',
    ));
    await act(async () => {
      submitForm(container.querySelector<HTMLFormElement>('.rss-feedback-form')!);
    });

    expect(sendFeedback).toHaveBeenCalledWith({
      targetToolCallId: 'strategy-call',
      message: '少解释一点，我想多保留自己的判断。',
    });
    expect(container.querySelector('.rss-feedback-form')).toBeNull();

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.rss-primary-action')!.click();
    });
    expect(confirmStrategy).toHaveBeenCalledWith('strategy-call');
    expect(container.querySelector('.rss-user-entry')).toBeNull();
  });

  it('renders Trial assistance Markdown in place and opens annotations in the reader popover', async () => {
    const confirmTrial = vi.fn().mockResolvedValue(undefined);
    const componentCommands = commands({ confirmTrial });
    const { container, root } = mount(
      <ReadingSetupTranscript
        entries={[trialEntry]}
        commands={componentCommands}
      />,
    );

    expect(container.querySelector('.rss-reading-guide strong')?.textContent)
      .toBe('规则');
    expect(container.querySelectorAll('.rss-after-reading li')).toHaveLength(2);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.rss-annotation-anchor')!.click();
    });
    expect(container.querySelector('.rss-annotation-note')).toBeNull();
    expect(container.querySelector('.note-dialog')).not.toBeNull();
    expect(container.querySelector('.note-dialog-content strong')?.textContent)
      .toBe('关系能否持续');
    expect(container.querySelector('.rss-annotation-anchor')?.getAttribute('aria-expanded'))
      .toBe('true');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container.querySelector('.note-dialog')).toBeNull();
    expect(container.querySelector('.rss-annotation-anchor')?.getAttribute('aria-expanded'))
      .toBe('false');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.rss-primary-action')!.click();
    });
    expect(confirmTrial).toHaveBeenCalledWith('trial-call');

    act(() => root.render(
      <ReadingSetupTranscript
        entries={[{ ...trialEntry, confirmation: 'completed' }]}
        commands={componentCommands}
      />,
    ));
    expect(container.textContent).toContain('这段试读已经确认');
    expect(container.textContent).not.toContain('就按这个方式，开始阅读');
    expect(container.querySelector('.rss-feedback-trigger')).toBeNull();
    expect(container.querySelector('.rss-user-entry')).toBeNull();
  });

  it('renders retry only when Notice explicitly projects a retry action', async () => {
    const retryConnection = vi.fn().mockResolvedValue(undefined);
    const componentCommands = commands({ retryConnection });
    const { container } = mount(
      <ReadingSetupTranscript
        entries={[
          {
            id: 'notice',
            kind: 'notice',
            tone: 'warning',
            message: '刚才断开了一下。',
            action: {
              kind: 'retry_connection',
              label: '重新连接',
            },
          },
        ]}
        commands={componentCommands}
      />,
    );

    await act(async () => {
      container.querySelector<HTMLButtonElement>('.rss-notice-entry button')!.click();
    });

    expect(retryConnection).toHaveBeenCalledOnce();
  });
});
