/** Verifies model stream parsing and OpenAI-compatible request construction. */

import { describe, expect, it, vi } from 'vitest';
import {
  createFakeModelEngine,
  createOpenAiCompatibleEngine,
  parseChatCompletionLine,
} from './index';

describe('parseChatCompletionLine', () => {
  it('extracts reasoning and content deltas', () => {
    const line =
      'data: {"choices":[{"delta":{"content":"你好","reasoning_content":"先想想"}}]}';
    expect(parseChatCompletionLine(line)).toEqual([
      { type: 'reasoning', text: '先想想' },
      { type: 'content', text: '你好' },
    ]);
  });

  it('recognizes the [DONE] sentinel', () => {
    expect(parseChatCompletionLine('data: [DONE]')).toBe('done');
  });

  it('ignores comments, blanks, and malformed payloads', () => {
    expect(parseChatCompletionLine(': keep-alive')).toBeNull();
    expect(parseChatCompletionLine('')).toBeNull();
    expect(parseChatCompletionLine('data: {not json')).toBeNull();
  });

  it('returns no events for an empty delta', () => {
    expect(parseChatCompletionLine('data: {"choices":[{"delta":{}}]}')).toEqual([]);
  });

  it('surfaces in-band error chunks as an error marker', () => {
    expect(
      parseChatCompletionLine('data: {"error":{"message":"rate limit exceeded"}}'),
    ).toEqual({ error: 'rate limit exceeded' });
    expect(parseChatCompletionLine('data: {"error":{}}')).toEqual({
      error: 'unknown model stream error',
    });
  });
});

describe('createFakeModelEngine', () => {
  it('streams a deterministic reply that echoes the prompt', async () => {
    const engine = createFakeModelEngine();
    let reply = '';
    for await (const event of engine.streamChat('测试')) {
      expect(event.type).toBe('content');
      reply += event.text;
    }
    expect(reply).toBe('（假模型）已收到：测试');
  });
});

describe('createOpenAiCompatibleEngine', () => {
  it('forwards the JSON response format to the provider request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('data: [DONE]\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      const engine = createOpenAiCompatibleEngine({
        baseUrl: 'https://model.example.test',
        apiKey: 'test-key',
        model: 'test-model',
      });
      for await (const _event of engine.streamChat('测试', {
        maxTokens: 4096,
        responseFormat: 'json',
      })) {
        // The mocked stream only emits the completion sentinel.
      }

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(String(init.body))).toMatchObject({
        max_tokens: 4096,
        response_format: { type: 'json_object' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
