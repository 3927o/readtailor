// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProgressiveTrialView } from './ProgressiveTrialView';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ProgressiveTrialView', () => {
  it('always renders three stable tabs and the selected provisional sample', () => {
    const html = renderToStaticMarkup(<ProgressiveTrialView
      model={{
        mode: 'selecting',
        activeOrdinal: 2,
        samples: [{
          ordinal: 2,
          tag: 'typical',
          sectionId: 'section-2',
          segment: 2,
          range: {
            start: { blockIndex: 1, offset: 0 },
            end: { blockIndex: 1, offset: 10 },
          },
          chapterPath: ['第二章'],
          originalHtml: '<p>第二段原文</p>',
          selectionReason: '典型结构',
        }],
      }}
      onSelectOrdinal={() => {}}
    />);

    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('第二段原文');
    expect(html).toContain('典型结构');
    expect(html).toContain('正在选择');
  });

  it('shows persisted generating samples and their per-slot status', () => {
    const html = renderToStaticMarkup(<ProgressiveTrialView
      model={{
        mode: 'generating',
        activeOrdinal: 1,
        samples: [{
          id: 'segment-1',
          ordinal: 1,
          status: 'generating',
          chapterPath: ['第一章'],
          selectionReason: '进入门槛',
          originalHtml: '<p>第一段原文</p>',
          viewedAt: null,
          tailoredContent: null,
        }],
      }}
      onSelectOrdinal={() => {}}
    />);

    expect(html).toContain('正在生成导读与裁读注');
    expect(html).toContain('第一段原文');
    expect(html).toContain('aria-busy="true"');
  });

  it('supports arrow, Home and End keyboard tab selection', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSelectOrdinal = vi.fn();
    act(() => {
      root.render(<ProgressiveTrialView
        model={{ mode: 'selecting', activeOrdinal: 1, samples: [] }}
        onSelectOrdinal={onSelectOrdinal}
      />);
    });
    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');

    act(() => {
      tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      tabs[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      tabs[2]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });

    expect(onSelectOrdinal.mock.calls.map(([ordinal]) => ordinal)).toEqual([2, 3, 1]);
    act(() => root.unmount());
    container.remove();
  });
});
