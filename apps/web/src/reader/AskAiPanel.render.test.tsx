import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QaAnswerContent } from './AskAiPanel';

describe('QaAnswerContent', () => {
  it('renders AI answers as markdown', () => {
    const html = renderToStaticMarkup(
      <QaAnswerContent content={'## 结论\n\n- **重点**\n- 使用 `示例`'} />,
    );

    expect(html).toContain('<h4>结论</h4>');
    expect(html).toContain('<ul><li><strong>重点</strong></li><li>使用 <code>示例</code></li></ul>');
    expect(html).not.toContain('##');
    expect(html).not.toContain('**');
  });
});
