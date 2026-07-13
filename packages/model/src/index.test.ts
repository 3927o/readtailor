import { describe, expect, it } from 'vitest';
import { createFakeModelEngine, parseChatCompletionLine } from './index';

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
