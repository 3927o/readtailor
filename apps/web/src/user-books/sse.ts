import { createParser } from 'eventsource-parser';
import { ApiError } from './apiError';

export interface PostJsonSseOptions<T> {
  path: string;
  body: Record<string, unknown>;
  onEvent(event: T): void;
  isTerminal(event: T): boolean;
  missingTerminalMessage: string;
  signal?: AbortSignal;
}

async function responseError(response: Response): Promise<ApiError> {
  if (response.status === 401) window.dispatchEvent(new Event('readtailor:unauthorized'));
  const body = await response.json().catch(() => null) as { error?: unknown } | null;
  return new ApiError(
    typeof body?.error === 'string' ? body.error : `请求失败（${response.status}）`,
    response.status,
  );
}

export async function postJsonSse<T>(options: PostJsonSseOptions<T>): Promise<void> {
  const response = await fetch(options.path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(options.body),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || !contentType.includes('text/event-stream') || !response.body) {
    throw await responseError(response);
  }

  let terminal = false;
  const parser = createParser({
    onEvent(message) {
      if (!message.data) return;
      let event: T;
      try {
        event = JSON.parse(message.data) as T;
      } catch {
        return;
      }
      options.onEvent(event);
      if (options.isTerminal(event)) terminal = true;
    },
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) parser.feed(tail);
    parser.reset({ consume: true });
    if (!terminal) throw new ApiError(options.missingTerminalMessage, 0);
  } finally {
    reader.releaseLock();
  }
}
