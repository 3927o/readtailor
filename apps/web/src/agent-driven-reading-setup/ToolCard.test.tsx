import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolCard } from './AgentDrivenReadingSetupPage';

describe('Reading setup ToolCard', () => {
  it('keeps confirmation disabled until the committed Tool is actionable', () => {
    const pending = renderToStaticMarkup(
      <ToolCard
        toolCallId="offer-1"
        toolName="offer_final_confirmation"
        argumentsValue={{ summary: '请确认' }}
        result={null}
        isError={false}
        interactive={false}
      />,
    );
    const committed = renderToStaticMarkup(
      <ToolCard
        toolCallId="offer-1"
        toolName="offer_final_confirmation"
        argumentsValue={{ summary: '请确认' }}
        result={{ toolCallId: 'offer-1' }}
        isError={false}
        interactive
      />,
    );
    expect(pending).toContain('disabled=""');
    expect(committed).not.toContain('disabled=""');
  });

  it('renders unknown tools without breaking the conversation', () => {
    const html = renderToStaticMarkup(
      <ToolCard
        toolCallId="future-1"
        toolName="future_tool"
        argumentsValue={{ value: 1 }}
        result={{ ok: true }}
        isError={false}
        interactive={false}
      />,
    );
    expect(html).toContain('工具：future_tool');
    expect(html).toContain('&quot;ok&quot;: true');
  });
});
