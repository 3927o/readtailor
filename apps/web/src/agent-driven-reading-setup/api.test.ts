import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunEvent } from '@readtailor/contracts';
import { subscribeReadingSetupRun } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function streamResponse(event: AgentRunEvent): Response {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

const runId = '11111111-1111-4111-8111-111111111111';

describe('Reading setup SSE client', () => {
  it('treats a terminal authoritative snapshot as a completed reconnect', async () => {
    const event: AgentRunEvent = {
      type: 'run_snapshot',
      runId,
      snapshot: {
        runId,
        lastSequence: 8,
        status: 'completed',
        assistantText: '完成',
        assistantMessage: null,
        tools: [],
        error: null,
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(event)));
    const events: AgentRunEvent[] = [];

    await expect(subscribeReadingSetupRun({
      sessionId: '22222222-2222-4222-8222-222222222222',
      runId,
      onEvent: (value) => events.push(value),
    })).resolves.toBeUndefined();
    expect(events).toEqual([event]);
  });

  it('reports a non-terminal EOF so the page can reconnect', async () => {
    const event: AgentRunEvent = {
      type: 'run_snapshot',
      runId,
      snapshot: {
        runId,
        lastSequence: 3,
        status: 'running',
        assistantText: '进行中',
        assistantMessage: null,
        tools: [],
        error: null,
      },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamResponse(event)));

    await expect(subscribeReadingSetupRun({
      sessionId: '22222222-2222-4222-8222-222222222222',
      runId,
      onEvent: () => undefined,
    })).rejects.toThrow('实时连接已中断');
  });
});
