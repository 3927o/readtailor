export type ModelStreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'content'; text: string };

export interface ModelEngine {
  name: string;
  streamChat(
    prompt: string,
    options?: { maxTokens?: number | undefined },
  ): AsyncIterable<ModelStreamEvent>;
}

interface ChatCompletionChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
    };
  }>;
}

/**
 * Parse a single SSE line from an OpenAI-compatible streaming response.
 * Returns 'done' on the [DONE] sentinel, the delta events on a data line,
 * and null for anything else (comments, keep-alives, blank lines).
 */
export function parseChatCompletionLine(line: string): ModelStreamEvent[] | 'done' | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return null;
  }

  const data = trimmed.slice('data:'.length).trim();
  if (data === '[DONE]') {
    return 'done';
  }

  let chunk: ChatCompletionChunk;
  try {
    chunk = JSON.parse(data) as ChatCompletionChunk;
  } catch {
    return null;
  }

  const delta = chunk.choices?.[0]?.delta;
  const events: ModelStreamEvent[] = [];
  if (delta?.reasoning_content) {
    events.push({ type: 'reasoning', text: delta.reasoning_content });
  }
  if (delta?.content) {
    events.push({ type: 'content', text: delta.content });
  }
  return events;
}

export function createOpenAiCompatibleEngine(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number | undefined;
}): ModelEngine {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');

  return {
    name: options.model,
    async *streamChat(prompt, streamOptions) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: streamOptions?.maxTokens ?? 2048,
          stream: true,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`model request failed: ${response.status} ${body.slice(0, 200)}`);
      }
      if (!response.body) {
        throw new Error('model response has no body');
      }

      const decoder = new TextDecoder();
      let buffer = '';
      for await (const bytes of response.body) {
        buffer += decoder.decode(bytes, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const parsed = parseChatCompletionLine(line);
          if (parsed === 'done') {
            return;
          }
          if (parsed) {
            yield* parsed;
          }
          newlineIndex = buffer.indexOf('\n');
        }
      }
    },
  };
}

export function createFakeModelEngine(): ModelEngine {
  return {
    name: 'fake',
    async *streamChat(prompt) {
      const reply = `（假模型）已收到：${prompt}`;
      for (const char of reply) {
        await new Promise((resolve) => setTimeout(resolve, 2));
        yield { type: 'content', text: char };
      }
    },
  };
}
