// @vitest-environment happy-dom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserBookDetail } from './api/http';
import type { TrialSnapshot } from './api/trial';
import { TrialPage } from './TrialPage';

const mocks = vi.hoisted(() => ({
  controller: null as Record<string, unknown> | null,
  submitFeedback: vi.fn(),
  adopt: vi.fn(),
}));

vi.mock('./useReadingSetupWorkflow', () => ({
  useReadingSetupWorkflow: () => ({ userBook }),
}));

vi.mock('./useTrialReviewController', () => ({
  useTrialReviewController: () => mocks.controller,
}));

vi.mock('./components', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./components')>();
  return {
    ...actual,
    WorkflowPage: ({ children }: { children: ReactNode }) => <main>{children}</main>,
    WorkflowMessage: ({ title, children }: { title: string; children: ReactNode }) => <section><h2>{title}</h2>{children}</section>,
    BackToShelf: () => <span>返回书架</span>,
  };
});

vi.mock('../reader/readerLayoutAnchor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reader/readerLayoutAnchor')>();
  return { ...actual, useReaderLayoutAnchor: vi.fn() };
});

vi.mock('./ProgressiveTrialView', () => ({
  ProgressiveTrialView: ({ model, onSelectOrdinal }: {
    model: { activeOrdinal: number };
    onSelectOrdinal(ordinal: 1 | 2 | 3): void;
  }) => (
    <section data-testid="trial-content" data-active-ordinal={model.activeOrdinal}>
      <span>样章原文 {model.activeOrdinal}</span>
      <button type="button" onClick={() => onSelectOrdinal(3)}>查看第三段</button>
    </section>
  ),
}));

vi.mock('../reader/NotePopover', () => ({
  NotePopover: () => null,
  popoverPlacement: vi.fn(),
}));

const userBook: UserBookDetail = {
  id: 'book-1',
  workflowStatus: 'trial_review',
  updatedAt: '2026-07-16T00:00:00.000Z',
  sharedBook: {
    id: 'shared-1',
    status: 'ready',
    title: 'Book',
    authors: [],
    coverPath: null,
    errorSummary: null,
  },
  readingProgress: null,
  currentStrategyDraftVersionId: 'draft-1',
  currentStrategyVersionId: null,
  currentTrialRevisionId: 'trial-1',
};

const snapshot: TrialSnapshot = {
  revisionId: 'trial-1',
  revision: 1,
  draftId: 'draft-1',
  status: 'ready',
  progress: { completed: 3, total: 3 },
  adjustmentCount: 0,
  adjustmentLimit: 5,
  canAdjust: true,
  canAdopt: true,
  samples: [1, 2, 3].map((ordinal) => ({
    id: `sample-${ordinal}`,
    ordinal: ordinal as 1 | 2 | 3,
    status: 'ready' as const,
    sectionId: `section-${ordinal}`,
    segment: ordinal,
    chapterPath: [`章节 ${ordinal}`],
    selectionReason: '原因',
    originalHtml: `<p>原文 ${ordinal}</p>`,
    viewedAt: '2026-07-16T00:00:00.000Z',
    tailoredContent: { guide: null, annotations: [], afterReading: null },
  })),
  errorSummary: null,
};

function controller(overrides: Record<string, unknown> = {}) {
  return {
    loading: false,
    loadError: null,
    retryLoad: vi.fn(),
    snapshot,
    samples: snapshot.samples,
    current: snapshot.samples[0],
    trialModel: {
      mode: 'review',
      samples: snapshot.samples,
      activeOrdinal: 1,
      assetBaseUrl: '',
    },
    revisionActive: false,
    revisionFailed: false,
    submitFeedback: mocks.submitFeedback,
    feedbackPending: false,
    viewedError: false,
    retryViewed: vi.fn(),
    retryPending: false,
    retryError: null,
    retryTrial: vi.fn(),
    adoptPending: false,
    adopt: mocks.adopt,
    mutationError: null,
    ...overrides,
  };
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  mocks.submitFeedback.mockReset();
  mocks.adopt.mockReset();
  mocks.controller = controller();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

describe('TrialPage feedback revision', () => {
  it('keeps the selected sample and feedback visible while the revision is running', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    roots.push(root);
    const render = () => root.render(<MemoryRouter initialEntries={['/user-books/book-1/trial']}><TrialPage /></MemoryRouter>);

    await act(async () => render());
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="trial-content"] button')!.click();
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '请缩短导读');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: '请缩短导读' }));
    });

    mocks.controller = controller({
      revisionActive: true,
      feedbackPending: true,
      trialModel: {
        mode: 'review',
        samples: snapshot.samples,
        activeOrdinal: 3,
        assetBaseUrl: '',
      },
      current: snapshot.samples[2],
    });
    await act(async () => render());

    expect(container.textContent).toContain('正在根据反馈重新起草处理方式，当前样章仍可查看');
    expect(container.textContent).toContain('样章原文 3');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('请缩短导读');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.disabled).toBe(true);
    expect([...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.includes('采用这个处理方式'))?.disabled).toBe(true);
  });

  it('retains feedback and offers a fresh submission after a terminal failure', async () => {
    const container = document.createElement('div');
    const root = createRoot(container);
    roots.push(root);
    const render = () => root.render(<MemoryRouter><TrialPage /></MemoryRouter>);

    await act(async () => render());
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, '保留关键注释');
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: '保留关键注释' }));
    });

    mocks.controller = controller({
      revisionFailed: true,
      mutationError: '处理方式保存失败，请重试',
    });
    await act(async () => render());

    const retry = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '重新提交反馈')!;
    expect(container.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('保留关键注释');
    expect(container.textContent).toContain('处理方式保存失败，请重试');
    expect(retry.disabled).toBe(false);

    await act(async () => retry.click());
    expect(mocks.submitFeedback).toHaveBeenCalledWith('保留关键注释');
  });
});
