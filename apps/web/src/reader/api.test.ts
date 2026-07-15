import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeReaderBootstrap, streamQaAnswer, type ReaderBootstrap } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function sseResponse(...frames: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const question = {
  question: 'Why?',
  idempotencyKey: 'question-key',
  sessionId: 'session-1',
};

describe('streamQaAnswer', () => {
  it('rejects EOF without done or error after preserving partial deltas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(
      'data: {"type":"answer_delta","chars":"partial answer"}\n\n',
    )));
    const onAnswer = vi.fn();
    const onDone = vi.fn();

    await expect(streamQaAnswer('book-1', question, { onAnswer, onDone }))
      .rejects.toThrow('问 AI 连接提前结束，请重试。');
    expect(onAnswer).toHaveBeenCalledWith('partial answer');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('resolves after a done event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(
      'data: {"type":"answer_delta","chars":"complete"}\n\n',
      'data: {"type":"done","sessionId":"session-1","messageId":"message-1"}\n\n',
    )));
    const onDone = vi.fn();

    await expect(streamQaAnswer('book-1', question, { onDone })).resolves.toBeUndefined();
    expect(onDone).toHaveBeenCalledWith('message-1', 'session-1');
  });

  it('dispatches tool lifecycle events without treating them as terminal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(
      'data: {"type":"tool_started","toolCallId":"call-1","toolName":"search_book"}\n\n',
      'data: {"type":"tool_finished","toolCallId":"call-1","toolName":"search_book","succeeded":false}\n\n',
      'data: {"type":"done","sessionId":"session-1","messageId":"message-1"}\n\n',
    )));
    const onToolStarted = vi.fn();
    const onToolFinished = vi.fn();

    await expect(streamQaAnswer('book-1', question, { onToolStarted, onToolFinished }))
      .resolves.toBeUndefined();
    expect(onToolStarted).toHaveBeenCalledWith({
      type: 'tool_started',
      toolCallId: 'call-1',
      toolName: 'search_book',
    });
    expect(onToolFinished).toHaveBeenCalledWith({
      type: 'tool_finished',
      toolCallId: 'call-1',
      toolName: 'search_book',
      succeeded: false,
    });
  });

  it('treats an in-band error as a terminal event', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(
      'data: {"type":"error","message":"generation failed"}\n\n',
    )));
    const onError = vi.fn();

    await expect(streamQaAnswer('book-1', question, { onError })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith('generation failed');
  });
});

function bootstrap(strategyVersion: number, observedAt = '2026-07-15T00:00:00.000Z'): ReaderBootstrap {
  return {
    userBookId: 'user-book',
    sharedBookId: 'book',
    workflowStatus: 'active_reading',
    strategyVersionId: `strategy-${strategyVersion}`,
    strategyVersion,
    briefing: {
      bookIdentity: '',
      arc: '',
      assumedKnowledge: '',
      readingAdvice: '',
    },
    strategySummary: '',
    enhancements: [],
    resumePosition: {
      sectionId: 'chapter',
      segment: 1,
      blockIndex: 1,
      offset: strategyVersion,
      clientObservedAt: observedAt,
      nodeOrder: 1,
      manifestVersion: 'manifest-1',
    },
    settings: { fontSize: 18, lineHeight: 1.95, contentWidth: 'medium', theme: 'system' },
    readNodes: [],
    highlights: [],
  };
}

describe('mergeReaderBootstrap', () => {
  it('rejects a late bootstrap from an older strategy version', () => {
    const current = bootstrap(3);
    expect(mergeReaderBootstrap(current, bootstrap(2))).toBe(current);
  });

  it('accepts a newer strategy while retaining a later observed resume position', () => {
    const current = bootstrap(2, '2026-07-15T02:00:00.000Z');
    const incoming = bootstrap(3, '2026-07-15T01:00:00.000Z');
    const merged = mergeReaderBootstrap(current, incoming);

    expect(merged.strategyVersion).toBe(3);
    expect(merged.resumePosition).toBe(current.resumePosition);
  });
});
