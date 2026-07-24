/** Defines and implements the HTTP/SSE transport consumed by the formal reading-setup controller. */

import type {
  AgentRunEvent,
  ReadingSetupSessionSnapshot,
  StartAgentRunResponse,
  SubmitReadingSetupActionRequest,
} from '@readtailor/contracts';
import { createParser } from 'eventsource-parser';
import { apiBaseUrl } from '../../library/api';
import {
  getJson,
  postJson,
  readJson,
  userBookRoot,
} from '../../user-books/api/http';

export interface ReadingSetupApi {
  getOrCreateSession(userBookId: string): Promise<ReadingSetupSessionSnapshot>;
  getSession(sessionId: string): Promise<ReadingSetupSessionSnapshot>;
  submitAction(
    sessionId: string,
    action: SubmitReadingSetupActionRequest,
  ): Promise<StartAgentRunResponse>;
  subscribeRun(options: {
    sessionId: string;
    runId: string;
    signal: AbortSignal;
    onEvent(event: AgentRunEvent): void;
  }): Promise<void>;
}

export const readingSetupQueryKeys = {
  all: ['reading-setup-session'] as const,
  byBook: (userBookId: string) =>
    [...readingSetupQueryKeys.all, 'book', userBookId] as const,
};

const sessionRoot = (sessionId: string) =>
  `${apiBaseUrl}/v1/reading-setup/sessions/${encodeURIComponent(sessionId)}`;

async function subscribeRun({
  sessionId,
  runId,
  signal,
  onEvent,
}: Parameters<ReadingSetupApi['subscribeRun']>[0]): Promise<void> {
  const response = await fetch(
    `${sessionRoot(sessionId)}/runs/${encodeURIComponent(runId)}/events`,
    { credentials: 'include', signal },
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
        onEvent(event);
        if (
          event.type === 'run_finished'
          || (
            event.type === 'run_snapshot'
            && (event.snapshot.status === 'completed' || event.snapshot.status === 'failed')
          )
        ) terminal = true;
      } catch {
        // A reconnect starts with an authoritative run_snapshot.
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
    if (!terminal && !signal.aborted) throw new Error('实时连接已中断');
  } finally {
    reader.releaseLock();
  }
}

export const readingSetupApi: ReadingSetupApi = {
  getOrCreateSession(userBookId) {
    return postJson(`${userBookRoot(userBookId)}/reading-setup/session`);
  },
  getSession(sessionId) {
    return getJson(sessionRoot(sessionId));
  },
  submitAction(sessionId, action) {
    return postJson(`${sessionRoot(sessionId)}/actions`, action);
  },
  subscribeRun,
};
