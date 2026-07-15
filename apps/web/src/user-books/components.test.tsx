// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssistanceContent, BriefCard } from './components';

describe('AssistanceContent', () => {
  it('renders inline bold instead of showing literal asterisks (the strategy-summary case)', () => {
    const html = renderToStaticMarkup(
      <AssistanceContent content={'1. **前置轻引导，后部渐放手**——每部开头给一个短提示。'} />,
    );
    expect(html).toContain('<strong>前置轻引导，后部渐放手</strong>');
    expect(html).not.toContain('**');
  });

  it('renders headings, tight lists and inline code', () => {
    const html = renderToStaticMarkup(
      <AssistanceContent content={'## 小节\n\n- 甲\n- 乙\n\n1. 一\n2. 二\n\n用 `code` 收尾'} />,
    );
    expect(html).toContain('<h4>小节</h4>');
    expect(html).toContain('<ul><li>甲</li><li>乙</li></ul>');
    expect(html).toContain('<ol><li>一</li><li>二</li></ol>');
    expect(html).toContain('<code>code</code>');
  });
});

describe('BriefCard', () => {
  it('preserves empty slots only for the streaming completed-style UI', () => {
    const briefing = { bookIdentity: '这是一本系统书。' };
    const streaming = renderToStaticMarkup(<BriefCard briefing={briefing} pending />);
    const legacy = renderToStaticMarkup(<BriefCard briefing={briefing} />);

    expect(streaming.match(/brief-section/g)).toHaveLength(4);
    expect(streaming).toContain('正在整理');
    expect(legacy.match(/brief-section/g)).toHaveLength(1);
    expect(legacy).not.toContain('正在整理');
  });
});
