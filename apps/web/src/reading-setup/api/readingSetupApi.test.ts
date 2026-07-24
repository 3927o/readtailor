/** Verifies the formal adapter's unified action request and reconnectable SSE semantics. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunEvent } from '@readtailor/contracts';
import { readingSetupApi } from './readingSetupApi';

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
  }));
}

const runId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

describe('readingSetupApi', () => {
  it('submits all user interactions through the unified action endpoint', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      runId,
      accepted: true,
    }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);

    await readingSetupApi.submitAction(sessionId, {
      type: 'feedback',
      targetToolCallId: 'strategy-1',
      message: '解释再少一点。',
    });

    expect(fetch).toHaveBeenCalledWith(
      `http://localhost:3001/v1/reading-setup/sessions/${sessionId}/actions`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({
          type: 'feedback',
          targetToolCallId: 'strategy-1',
          message: '解释再少一点。',
        }),
      }),
    );
  });

  it('accepts a terminal run_snapshot as a clean reconnect result', async () => {
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

    await expect(readingSetupApi.subscribeRun({
      sessionId,
      runId,
      signal: new AbortController().signal,
      onEvent: (value) => events.push(value),
    })).resolves.toBeUndefined();
    expect(events).toEqual([event]);
  });

  it('reports a non-terminal EOF so the controller can reconnect', async () => {
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

    await expect(readingSetupApi.subscribeRun({
      sessionId,
      runId,
      signal: new AbortController().signal,
      onEvent: () => undefined,
    })).rejects.toThrow('实时连接已中断');
  });
});
