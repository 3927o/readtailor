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
          sectionId: 'section-1',
          segment: 1,
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

  it('renders assistance only for a ready sample with tailored content', () => {
    const html = renderToStaticMarkup(<ProgressiveTrialView
      model={{
        mode: 'review',
        activeOrdinal: 1,
        samples: [{
          id: 'segment-1',
          ordinal: 1,
          status: 'ready',
          sectionId: 'section-1',
          segment: 1,
          chapterPath: ['第一章'],
          selectionReason: '进入门槛',
          originalHtml: '<p>第一段原文</p>',
          viewedAt: null,
          tailoredContent: {
            guide: '先看结构',
            annotations: [{
              id: 'annotation-1',
              range: {
                start: { blockIndex: 1, offset: 0 },
                end: { blockIndex: 1, offset: 2 },
              },
              content: '关键概念',
            }],
            afterReading: '回看结论',
          },
        }],
      }}
      onSelectOrdinal={() => {}}
    />);

    expect(html).toContain('先看结构');
    expect(html).toContain('回看结论');
    expect(html).toContain('data-annotation-id="annotation-1"');
    expect(html).toContain('reader-original trial-original');
  });

  it('does not read tailored payloads from a non-ready sample', () => {
    const html = renderToStaticMarkup(<ProgressiveTrialView
      model={{
        mode: 'generating',
        activeOrdinal: 1,
        samples: [{
          id: 'segment-1',
          ordinal: 1,
          status: 'generating',
          sectionId: 'section-1',
          segment: 1,
          chapterPath: ['第一章'],
          selectionReason: '进入门槛',
          originalHtml: '<p>第一段原文</p>',
          viewedAt: null,
          tailoredContent: {
            guide: '不应出现',
            annotations: [],
            afterReading: '也不应出现',
          },
        } as unknown as import('./api').TrialSample],
      }}
      onSelectOrdinal={() => {}}
    />);

    expect(html).not.toContain('不应出现');
    expect(html).not.toContain('也不应出现');
    expect(html).toContain('第一段原文');
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

  it('forwards clicks from ready annotation anchors', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onAnnotationClick = vi.fn();
    act(() => {
      root.render(<ProgressiveTrialView
        model={{
          mode: 'review',
          activeOrdinal: 1,
          samples: [{
            id: 'segment-1',
            ordinal: 1,
            status: 'ready',
            sectionId: 'section-1',
            segment: 1,
            chapterPath: ['第一章'],
            selectionReason: '进入门槛',
            originalHtml: '<p>第一段原文</p>',
            viewedAt: null,
            tailoredContent: {
              guide: null,
              annotations: [{
                id: 'annotation-1',
                range: {
                  start: { blockIndex: 1, offset: 0 },
                  end: { blockIndex: 1, offset: 2 },
                },
                content: '关键概念',
              }],
              afterReading: null,
            },
          }],
        }}
        onSelectOrdinal={() => {}}
        onAnnotationClick={onAnnotationClick}
      />);
    });
    const anchor = container.querySelector<HTMLElement>('[data-annotation-id="annotation-1"]');

    act(() => anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(onAnnotationClick).toHaveBeenCalledWith('annotation-1', anchor);
    act(() => root.unmount());
    container.remove();
  });
});
