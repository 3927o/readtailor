/** Verifies the canonical Tool interpretation of committed and in-attempt Agent messages. */

import { describe, expect, it } from 'vitest';
import type { AgentJsonValue, AgentMessageDto } from '@readtailor/contracts';
import { indexAgentTranscript } from './transcript-index';

function assistantToolCalls(
  calls: Array<{ id: string; name: string }>,
): AgentMessageDto {
  return {
    role: 'assistant',
    content: calls.map((call) => ({
      type: 'toolCall' as const,
      id: call.id,
      name: call.name,
      arguments: { value: call.id },
    })),
    api: 'openai-completions',
    provider: 'test',
    model: 'test',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'toolUse',
    timestamp: 1,
  };
}

function toolResult(
  toolCallId: string,
  options: { isError?: boolean; details?: AgentJsonValue } = {},
): AgentMessageDto {
  return {
    role: 'toolResult',
    toolCallId,
    toolName: 'publish_strategy',
    content: [{ type: 'text', text: `result:${toolCallId}` }],
    ...(options.details === undefined ? {} : { details: options.details }),
    isError: options.isError ?? false,
    timestamp: 2,
  };
}

describe('Agent transcript index', () => {
  it('indexes pending, successful and failed Tool calls with one success rule', () => {
    const messages: AgentMessageDto[] = [
      assistantToolCalls([
        { id: 'pending', name: 'publish_strategy' },
        { id: 'failed', name: 'publish_strategy' },
        { id: 'successful', name: 'publish_strategy' },
        { id: 'fallback', name: 'publish_strategy' },
      ]),
      toolResult('failed', { isError: true }),
      toolResult('successful', { details: { normalized: true } }),
      toolResult('fallback'),
    ];
    const index = indexAgentTranscript(messages);

    expect(index.get('pending')?.status).toBe('pending');
    expect(index.get('failed')?.status).toBe('failed');
    expect(index.getSuccessful('failed', 'publish_strategy')).toBeUndefined();
    expect(index.getSuccessful('successful', 'other_tool')).toBeUndefined();
    expect(index.getSuccessful('successful', 'publish_strategy')).toMatchObject({
      result: { normalized: true },
      status: 'succeeded',
    });
    expect(index.getSuccessful('fallback', 'publish_strategy')).toMatchObject({
      result: [{ type: 'text', text: 'result:fallback' }],
      status: 'succeeded',
    });
    expect(index.latestSuccessful('publish_strategy')?.toolCallId).toBe('fallback');
  });

  it('can index an explicit committed plus current-attempt message list', () => {
    const committed = [assistantToolCalls([{ id: 'old', name: 'publish_strategy' }])];
    const currentAttempt = [
      assistantToolCalls([{ id: 'new', name: 'publish_strategy' }]),
      toolResult('new'),
    ];
    const index = indexAgentTranscript([...committed, ...currentAttempt]);

    expect(index.get('old')?.status).toBe('pending');
    expect(index.getSuccessful('new', 'publish_strategy')?.toolCallId).toBe('new');
  });
});
