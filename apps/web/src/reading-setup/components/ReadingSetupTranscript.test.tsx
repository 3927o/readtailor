// @vitest-environment happy-dom
/** Verifies first-batch transcript rendering and question interactions against view-model updates. */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useReadingSetupMockSource } from '../mocks/useReadingSetupMockSource';
import type { ReadingSetupCommands } from '../session/types';
import type {
  QuestionTranscriptEntry,
  ReadingSetupTranscriptEntry,
} from '../transcript/types';
import { ReadingSetupTranscript } from './ReadingSetupTranscript';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<ReturnType<typeof createRoot>> = [];

function commands(
  answerQuestion: ReadingSetupCommands['answerQuestion'] = vi.fn(),
): ReadingSetupCommands {
  return {
    answerQuestion,
    sendFeedback: vi.fn(),
    confirmStrategy: vi.fn(),
    confirmTrial: vi.fn(),
    retryConnection: vi.fn(),
  };
}

function mountWithRoot(content: React.ReactNode) {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(content));
  return { container, root };
}

function mount(content: React.ReactNode) {
  return mountWithRoot(content).container;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
    ?.set?.call(textarea, value);
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
}

function submitForm(form: HTMLFormElement) {
  form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.useRealTimers();
});

describe('ReadingSetupTranscript first component batch', () => {
  it('renders streaming Assistant Markdown and lightweight user delivery feedback', () => {
    const entries: ReadingSetupTranscriptEntry[] = [
      {
        id: 'assistant',
        kind: 'assistant',
        text: '我先看两个方向：\n\n- **理解结构**\n- 找到 `方法`',
        streaming: true,
      },
      {
        id: 'answer',
        kind: 'user',
        text: '我更想带走一套能反复使用的判断方式。',
        delivery: 'sending',
      },
    ];

    const html = renderToStaticMarkup(
      <ReadingSetupTranscript entries={entries} commands={commands()} />,
    );

    expect(html).toContain('rss-stream-cursor');
    expect(html).toContain('<ul><li><strong>理解结构</strong></li><li>找到 <code>方法</code>');
    expect(html).not.toContain('**');
    expect(html).toContain('rss-user-entry');
    expect(html).toContain('发送中');
    expect(html).not.toContain('rss-user-label');
  });

  it('keeps one Question shell while its prompt and options arrive', () => {
    const initialEntry: QuestionTranscriptEntry = {
      id: 'streaming-question',
      kind: 'question',
      toolCallId: 'streaming-question-call',
      renderState: 'streaming',
      prompt: '遇到抽象段落时，',
      options: [],
    };
    const componentCommands = commands();
    const { container, root } = mountWithRoot(
      <ReadingSetupTranscript
        entries={[initialEntry]}
        commands={componentCommands}
      />,
    );
    const questionShell = container.querySelector('.rss-question-entry');
    expect(container.querySelector('.rss-question-entry form')).toBeNull();

    act(() => root.render(
      <ReadingSetupTranscript
        entries={[{
          ...initialEntry,
          prompt: '遇到抽象段落时，你希望我怎么陪你？',
          options: [{ id: 'light', label: '给一句轻量提醒' }],
        }]}
        commands={componentCommands}
      />,
    ));

    expect(container.querySelector('.rss-question-entry')).toBe(questionShell);
    const streamedOption = container.querySelector<HTMLButtonElement>(
      '.rss-question-options button',
    );
    expect(streamedOption?.disabled).toBe(true);

    act(() => root.render(
      <ReadingSetupTranscript
        entries={[{
          ...initialEntry,
          renderState: 'ready',
          prompt: '遇到抽象段落时，你希望我怎么陪你？',
          options: [{ id: 'light', label: '给一句轻量提醒' }],
        }]}
        commands={componentCommands}
      />,
    ));

    expect(container.querySelector('.rss-question-entry')).toBe(questionShell);
    expect(container.querySelector('.rss-question-options button')).toBe(streamedOption);
    expect(container.querySelector<HTMLButtonElement>(
      '.rss-question-options button',
    )?.disabled).toBe(false);
  });

  it('uses the mock controller to replace an answered form with an independent UserEntry', async () => {
    vi.useFakeTimers();

    function MockTranscript() {
      const controller = useReadingSetupMockSource();
      return (
        <ReadingSetupTranscript
          entries={controller.view.entries}
          commands={controller.commands}
          interactionsLocked={controller.view.interactionsLocked}
        />
      );
    }

    const container = mount(<MockTranscript />);
    await act(async () => vi.advanceTimersByTimeAsync(3_100));
    const optionButtons = [...container.querySelectorAll<HTMLButtonElement>(
      '.rss-question-options button',
    )];

    await act(async () => {
      optionButtons[1]!.click();
    });

    expect(container.querySelector('.rss-question-entry form')).toBeNull();
    const userEntries = container.querySelectorAll('.rss-user-entry > p');
    expect(userEntries.item(userEntries.length - 1).textContent)
      .toBe('进入段落前给一句轻量提醒');
  });

  it('submits a choice immediately without rendering a second confirmation button', async () => {
    const answerQuestion = vi.fn().mockResolvedValue(undefined);
    const entry: QuestionTranscriptEntry = {
      id: 'choice-question',
      kind: 'question',
      toolCallId: 'choice-question-call',
      renderState: 'ready',
      prompt: '哪几件事更接近你现在的想法？',
      options: [
        { id: 'one', label: '先理解整体结构' },
        { id: 'two', label: '再找可以实践的方法' },
      ],
      allowFreeText: false,
    };
    const container = mount(
      <ReadingSetupTranscript entries={[entry]} commands={commands(answerQuestion)} />,
    );
    const optionButtons = [...container.querySelectorAll<HTMLButtonElement>(
      '.rss-question-options button',
    )];
    expect(container.querySelector('button[type="submit"]')).toBeNull();

    await act(async () => {
      optionButtons[1]!.click();
    });

    expect(answerQuestion).toHaveBeenCalledWith({
      toolCallId: 'choice-question-call',
      selectedOptionIds: ['two'],
      freeText: null,
    });
  });

  it('submits a free-text-only answer and trims its surrounding whitespace', async () => {
    const answerQuestion = vi.fn().mockResolvedValue(undefined);
    const entry: QuestionTranscriptEntry = {
      id: 'free-text-question',
      kind: 'question',
      toolCallId: 'free-text-question-call',
      renderState: 'ready',
      prompt: '你也可以直接告诉我。',
      options: [],
      allowFreeText: true,
    };
    const container = mount(
      <ReadingSetupTranscript entries={[entry]} commands={commands(answerQuestion)} />,
    );
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;

    await act(async () => setTextareaValue(textarea, '  我想重新理解长期工作。  '));
    await act(async () => {
      submitForm(container.querySelector<HTMLFormElement>('.rss-question-entry form')!);
    });

    expect(answerQuestion).toHaveBeenCalledWith({
      toolCallId: 'free-text-question-call',
      selectedOptionIds: [],
      freeText: '我想重新理解长期工作。',
    });
  });
});
