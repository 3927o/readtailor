import { afterEach, describe, expect, it, vi } from 'vitest';
import { postJsonSse, type PostJsonSseOptions } from './sse';

afterEach(() => {
  vi.unstubAllGlobals();
});

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

async function consume(
  response: Response,
  options: Partial<PostJsonSseOptions<{ type: string; text?: string }>> = {},
) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  const events: Array<{ type: string; text?: string }> = [];
  await postJsonSse<{ type: string; text?: string }>({
    path: '/stream',
    body: { command: 'test' },
    onEvent: (event) => events.push(event),
    isTerminal: (event) => event.type === 'done',
    missingTerminalMessage: 'missing terminal',
    ...options,
  });
  return events;
}

describe('postJsonSse', () => {
  it('parses arbitrary UTF-8 chunks, CRLF, multi-line data, and heartbeats', async () => {
    const source = [
      ': heartbeat\r\n',
      'data: {"type":\r\n',
      'data: "done", "text": "中文"}\r\n',
      '\r\n',
    ].join('');
    const bytes = new TextEncoder().encode(source);
    const chineseByte = bytes.findIndex((value) => value >= 0x80);

    const events = await consume(responseFromChunks([
      bytes.slice(0, 7),
      bytes.slice(7, chineseByte + 1),
      bytes.slice(chineseByte + 1, chineseByte + 2),
      bytes.slice(chineseByte + 2),
    ]));

    expect(events).toEqual([{ type: 'done', text: '中文' }]);
    expect(fetch).toHaveBeenCalledWith('/stream', expect.objectContaining({
      method: 'POST',
      credentials: 'include',
      body: '{"command":"test"}',
    }));
  });

  it('ignores malformed JSON frames and continues to a valid terminal event', async () => {
    const source = [
      'data: {broken}\n\n',
      'data: {"type":"done"}\n\n',
    ].join('');

    await expect(consume(responseFromChunks([new TextEncoder().encode(source)])))
      .resolves.toEqual([{ type: 'done' }]);
  });

  it('reports EOF without a terminal event as a recoverable ApiError', async () => {
    const source = 'data: {"type":"progress"}\n\n';

    await expect(consume(responseFromChunks([new TextEncoder().encode(source)])))
      .rejects.toMatchObject({ name: 'ApiError', status: 0, message: 'missing terminal' });
  });

  it('passes the AbortSignal through and rejects when an active stream is aborted', async () => {
    const abort = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_path, init?: RequestInit) => {
      const signal = init?.signal;
      return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => {
            controller.error(signal.reason);
          }, { once: true });
        },
      }), { headers: { 'content-type': 'text/event-stream' } }));
    }));

    const request = postJsonSse({
      path: '/stream',
      body: {},
      signal: abort.signal,
      onEvent: () => {},
      isTerminal: () => false,
      missingTerminalMessage: 'missing terminal',
    });
    abort.abort(new DOMException('cancelled', 'AbortError'));

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
  });
});
