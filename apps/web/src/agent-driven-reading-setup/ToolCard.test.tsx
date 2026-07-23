/** Verifies interaction availability and unknown-tool fallback in the legacy Tool card. */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolCard } from './AgentDrivenReadingSetupPage';

describe('Reading setup ToolCard', () => {
  it('keeps confirmation disabled until the committed Tool is actionable', () => {
    const pending = renderToStaticMarkup(
      <ToolCard
        toolCallId="trial-1"
        toolName="generate_trial_slice"
        argumentsValue={{ reason: '试试这个方式' }}
        result={null}
        isError={false}
        interactive={false}
      />,
    );
    const committed = renderToStaticMarkup(
      <ToolCard
        toolCallId="trial-1"
        toolName="generate_trial_slice"
        argumentsValue={{ reason: '试试这个方式' }}
        result={{ toolCallId: 'trial-1' }}
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
