import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentCallLogs,
  httpRequestLogs,
  type Database,
} from '@readtailor/database';
import { createPerfSink, timeAgentCall, type PerfSink } from './perf-sink';

function createFakeDb(options: { fail?: boolean } = {}) {
  const httpRows: Array<Record<string, unknown>> = [];
  const agentRows: Array<Record<string, unknown>> = [];
  const db = {
    insert(table: unknown) {
      return {
        async values(rows: unknown) {
          if (options.fail) throw new Error('insert failed');
          const target = table === httpRequestLogs ? httpRows : agentRows;
          target.push(...(Array.isArray(rows) ? rows : [rows]) as Array<Record<string, unknown>>);
        },
      };
    },
  } as unknown as Database;
  return { db, httpRows, agentRows };
}

function createLogger() {
  return { warn: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createPerfSink', () => {
  it('flushes when the batch threshold is reached', async () => {
    const { db, httpRows } = createFakeDb();
    const sink = createPerfSink({ db, logger: createLogger(), maxBatch: 2 });

    sink.recordHttp({
      requestId: 'req-1',
      method: 'GET',
      route: '/health',
      statusCode: 200,
      durationMs: 3.4,
    });
    sink.recordHttp({
      requestId: 'req-2',
      method: 'POST',
      route: '/v1/system/chat',
      statusCode: 202,
      durationMs: 6.5,
    });

    await vi.waitFor(() => expect(httpRows).toHaveLength(2));
    expect(httpRows[0]).toMatchObject({ requestId: 'req-1', durationMs: 3 });
    expect(httpRows[1]).toMatchObject({ requestId: 'req-2', durationMs: 7 });
  });

  it('flushes after the interval elapses', async () => {
    vi.useFakeTimers();
    const { db, agentRows } = createFakeDb();
    const sink = createPerfSink({
      db,
      logger: createLogger(),
      flushIntervalMs: 50,
      maxBatch: 100,
    });

    sink.recordAgentCall({
      source: 'api',
      kind: 'system_chat',
      model: 'test-model',
      status: 'ok',
      durationMs: 12,
      promptChars: 3,
      outputChars: 4,
      sessionId: 'session-1',
      conversationVersion: 4,
      traceEvents: [{ type: 'turn_started', turn: 1 }],
    });
    expect(agentRows).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(50);

    expect(agentRows).toHaveLength(1);
    expect(agentRows[0]).toMatchObject({
      source: 'api',
      kind: 'system_chat',
      model: 'test-model',
      promptChars: 3,
      outputChars: 4,
      sessionId: 'session-1',
      conversationVersion: 4,
      traceEvents: [{ type: 'turn_started', turn: 1 }],
    });
  });

  it('warns and drops a failed batch without throwing', async () => {
    const { db } = createFakeDb({ fail: true });
    const logger = createLogger();
    const sink = createPerfSink({ db, logger, maxBatch: 1 });

    expect(() => sink.recordHttp({
      requestId: 'req-1',
      method: 'GET',
      route: '/health',
      statusCode: 200,
      durationMs: 1,
    })).not.toThrow();

    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledTimes(1));
    await expect(sink.close()).resolves.toBeUndefined();
  });

  it('flushes remaining events on close', async () => {
    const { db, httpRows, agentRows } = createFakeDb();
    const sink = createPerfSink({ db, logger: createLogger(), maxBatch: 100 });

    sink.recordHttp({
      requestId: 'req-1',
      method: 'GET',
      route: '/health',
      statusCode: 200,
      durationMs: 1,
    });
    sink.recordAgentCall({
      requestId: 'req-1',
      source: 'worker',
      kind: 'normalization',
      model: 'test-model',
      status: 'error',
      durationMs: 10,
      turnCount: 2,
      errorSummary: 'boom',
    });

    await sink.close();

    expect(httpRows).toHaveLength(1);
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0]).toMatchObject({
      requestId: 'req-1',
      source: 'worker',
      kind: 'normalization',
      status: 'error',
      turnCount: 2,
      errorSummary: 'boom',
    });
  });

  it('records trace summary collected before an agent call fails', async () => {
    const rows: Array<Record<string, unknown>> = [];
    const sink: PerfSink = {
      recordHttp() {},
      recordAgentCall(event) {
        rows.push(event as unknown as Record<string, unknown>);
      },
      async close() {},
    };
    const traceEvents: Array<Record<string, unknown>> = [{ type: 'turn_started', turn: 1 }];

    await expect(timeAgentCall(
      sink,
      {
        source: 'api',
        kind: 'reading_setup.interviewing',
        model: 'test-model',
        traceEvents,
      },
      async () => {
        traceEvents.push({ type: 'tool_finished', turn: 1, succeeded: false });
        throw new Error('agent failed');
      },
      { onError: () => ({ turnCount: 1 }) },
    )).rejects.toThrow('agent failed');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'error',
      turnCount: 1,
      errorSummary: 'agent failed',
      traceEvents: [
        { type: 'turn_started', turn: 1 },
        { type: 'tool_finished', turn: 1, succeeded: false },
      ],
    });
  });
});
