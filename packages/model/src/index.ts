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
  error?: {
    message?: string;
  };
}

/**
 * Parse a single SSE line from an OpenAI-compatible streaming response.
 * Returns 'done' on the [DONE] sentinel, an error marker on an in-band error
 * chunk, the delta events on a data line, and null for anything else
 * (comments, keep-alives, blank lines).
 */
export function parseChatCompletionLine(
  line: string,
): ModelStreamEvent[] | 'done' | { error: string } | null {
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

  // 有些上游先回 200 再用带内 error 块报错（限流、内容策略等），必须当失败处理。
  if (chunk.error) {
    return { error: chunk.error.message ?? 'unknown model stream error' };
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
        // 注意：这是整条流的总时长上限（fetch 的 signal 覆盖到 body 读完），
        // 推理模型的长回答可能持续数分钟，默认给 10 分钟。
        signal: AbortSignal.timeout(options.timeoutMs ?? 600_000),
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
      let done = false;
      const consume = function* (text: string): Generator<ModelStreamEvent> {
        buffer += text;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const parsed = parseChatCompletionLine(line);
          if (parsed === 'done') {
            done = true;
            return;
          }
          if (parsed && 'error' in parsed) {
            throw new Error(`model stream error: ${parsed.error}`);
          }
          if (parsed) {
            yield* parsed;
          }
        }
      };

      for await (const bytes of response.body) {
        yield* consume(decoder.decode(bytes, { stream: true }));
        if (done) {
          return;
        }
      }
      // 上游可能不发结尾换行/[DONE] 就断开：冲刷解码器并处理残留的最后一行。
      yield* consume(`${decoder.decode()}\n`);
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
