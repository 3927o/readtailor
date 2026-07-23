import type {
  ReadingSetupSessionSnapshot,
  AgentRunEvent,
  ConfirmReadingSetupResponse,
  StartAgentRunResponse,
  SubmitAgentQuestionAnswerRequest,
} from '@readtailor/contracts';
import { createParser } from 'eventsource-parser';
import { apiBaseUrl } from '../library/api';
import { getJson, postJson, readJson, userBookRoot } from '../user-books/api/http';

export const readingSetupKeys = {
  all: ['reading-setup'] as const,
  sessionByBook: (userBookId: string) =>
    [...readingSetupKeys.all, 'book', userBookId] as const,
  session: (sessionId: string) =>
    [...readingSetupKeys.all, 'session', sessionId] as const,
  run: (sessionId: string, runId: string) =>
    [...readingSetupKeys.session(sessionId), 'run', runId] as const,
};

const sessionRoot = (sessionId: string) =>
  `${apiBaseUrl}/v1/reading-setup/sessions/${encodeURIComponent(sessionId)}`;

export function createReadingSetupSession(
  userBookId: string,
): Promise<ReadingSetupSessionSnapshot> {
  return postJson(`${userBookRoot(userBookId)}/reading-setup/session`);
}

export function getReadingSetupSession(
  sessionId: string,
): Promise<ReadingSetupSessionSnapshot> {
  return getJson(sessionRoot(sessionId));
}

export function submitReadingSetupMessage(
  sessionId: string,
  message: string,
): Promise<StartAgentRunResponse> {
  return postJson(`${sessionRoot(sessionId)}/messages`, { message });
}

export function submitReadingSetupQuestionAnswer(
  sessionId: string,
  input: SubmitAgentQuestionAnswerRequest,
): Promise<StartAgentRunResponse> {
  return postJson(`${sessionRoot(sessionId)}/question-answers`, input);
}

export function confirmReadingSetup(
  sessionId: string,
  offerToolCallId: string,
): Promise<ConfirmReadingSetupResponse> {
  return postJson(`${sessionRoot(sessionId)}/confirm`, { offerToolCallId });
}

export async function subscribeReadingSetupRun(options: {
  sessionId: string;
  runId: string;
  onEvent(event: AgentRunEvent): void;
  signal?: AbortSignal;
}): Promise<void> {
  const response = await fetch(
    `${sessionRoot(options.sessionId)}/runs/${encodeURIComponent(options.runId)}/events`,
    {
      credentials: 'include',
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (!response.ok || !response.body) {
    await readJson(response);
    return;
  }
  let terminal = false;
  const parser = createParser({
    onEvent(message) {
      if (!message.data) return;
      try {
        const event = JSON.parse(message.data) as AgentRunEvent;
        options.onEvent(event);
        if (
          event.type === 'run_finished' ||
          (event.type === 'run_snapshot' &&
            (event.snapshot.status === 'completed' || event.snapshot.status === 'failed'))
        ) terminal = true;
      } catch {
        // Ignore malformed transport frames; the next run_snapshot is authoritative.
      }
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
    if (!terminal && !options.signal?.aborted) throw new Error('实时连接已中断');
  } finally {
    reader.releaseLock();
  }
}
