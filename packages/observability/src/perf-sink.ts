import type { Logger } from 'pino';
import {
  agentCallLogs,
  httpRequestLogs,
  type Database,
} from '@readtailor/database';

export type AgentCallSource = 'api' | 'worker';
export type AgentCallStatus = 'ok' | 'error';

export type HttpRequestPerfEvent = {
  requestId: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  userId?: string | null;
  createdAt?: Date;
};

export type AgentCallPerfEvent = {
  requestId?: string | null;
  source: AgentCallSource;
  kind: string;
  model: string;
  status: AgentCallStatus;
  durationMs: number;
  promptChars?: number | null;
  outputChars?: number | null;
  turnCount?: number | null;
  errorSummary?: string | null;
  createdAt?: Date;
};

export type AgentCallTimingMeta = Omit<
  AgentCallPerfEvent,
  'status' | 'durationMs' | 'errorSummary' | 'createdAt'
> & {
  promptChars?: number | null;
  outputChars?: number | null;
  turnCount?: number | null;
};

export type PerfSink = {
  recordHttp(event: HttpRequestPerfEvent): void;
  recordAgentCall(event: AgentCallPerfEvent): void;
  close(): Promise<void>;
};

type PerfSinkLogger = Pick<Logger, 'warn'>;

type PendingEvent =
  | { type: 'http'; event: Required<Omit<HttpRequestPerfEvent, 'userId'>> & { userId: string | null } }
  | { type: 'agent'; event: Required<AgentCallPerfEvent> };

function nonnegativeInteger(value: number): number {
  return Math.max(0, Math.round(Number.isFinite(value) ? value : 0));
}

function optionalInteger(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function errorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 1000);
}

export function createPerfSink(options: {
  db: Database;
  logger: PerfSinkLogger;
  flushIntervalMs?: number;
  maxBatch?: number;
  maxBuffer?: number;
}): PerfSink {
  const flushIntervalMs = options.flushIntervalMs ?? 2000;
  const maxBatch = options.maxBatch ?? 100;
  const maxBuffer = options.maxBuffer ?? 1000;
  const buffer: PendingEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushing: Promise<void> | undefined;
  let closed = false;
  let droppedOldest = 0;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const schedule = () => {
    if (closed || timer || buffer.length === 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, flushIntervalMs);
    timer.unref?.();
  };

  const flush = async (): Promise<void> => {
    if (flushing) return flushing;
    clearTimer();
    flushing = (async () => {
      const batch = buffer.splice(0, maxBatch);
      if (batch.length === 0) return;
      const httpRows = batch
        .filter((item): item is Extract<PendingEvent, { type: 'http' }> => item.type === 'http')
        .map((item) => item.event);
      const agentRows = batch
        .filter((item): item is Extract<PendingEvent, { type: 'agent' }> => item.type === 'agent')
        .map((item) => item.event);
      try {
        if (httpRows.length > 0) {
          await options.db.insert(httpRequestLogs).values(httpRows);
        }
        if (agentRows.length > 0) {
          await options.db.insert(agentCallLogs).values(agentRows);
        }
      } catch (error) {
        options.logger.warn(
          { err: error, rows: batch.length },
          'failed to write performance logs; dropping batch',
        );
      }
    })().finally(() => {
      flushing = undefined;
      if (!closed && buffer.length > 0) {
        if (buffer.length >= maxBatch) {
          void flush();
        } else {
          schedule();
        }
      }
    });
    return flushing;
  };

  const enqueue = (event: PendingEvent) => {
    if (closed) return;
    buffer.push(event);
    if (buffer.length > maxBuffer) {
      const dropCount = buffer.length - maxBuffer;
      buffer.splice(0, dropCount);
      droppedOldest += dropCount;
      options.logger.warn(
        { dropped: dropCount, droppedOldest, maxBuffer },
        'performance log buffer exceeded capacity; dropping oldest events',
      );
    }
    if (buffer.length >= maxBatch) {
      void flush();
    } else {
      schedule();
    }
  };

  return {
    recordHttp(event) {
      enqueue({
        type: 'http',
        event: {
          requestId: event.requestId,
          method: event.method,
          route: event.route,
          statusCode: event.statusCode,
          durationMs: nonnegativeInteger(event.durationMs),
          userId: event.userId ?? null,
          createdAt: event.createdAt ?? new Date(),
        },
      });
    },
    recordAgentCall(event) {
      enqueue({
        type: 'agent',
        event: {
          requestId: event.requestId ?? null,
          source: event.source,
          kind: event.kind,
          model: event.model,
          status: event.status,
          durationMs: nonnegativeInteger(event.durationMs),
          promptChars: optionalInteger(event.promptChars),
          outputChars: optionalInteger(event.outputChars),
          turnCount: optionalInteger(event.turnCount),
          errorSummary: event.errorSummary ?? null,
          createdAt: event.createdAt ?? new Date(),
        },
      });
    },
    async close() {
      closed = true;
      clearTimer();
      if (flushing) await flushing;
      while (buffer.length > 0) {
        await flush();
      }
    },
  };
}

export async function timeAgentCall<T>(
  sink: PerfSink | undefined,
  meta: AgentCallTimingMeta,
  fn: () => Promise<T>,
  options: {
    onSuccess?: (value: T) => Partial<AgentCallTimingMeta>;
  } = {},
): Promise<T> {
  const started = performance.now();
  try {
    const value = await fn();
    sink?.recordAgentCall({
      ...meta,
      ...options.onSuccess?.(value),
      status: 'ok',
      durationMs: performance.now() - started,
    });
    return value;
  } catch (error) {
    sink?.recordAgentCall({
      ...meta,
      status: 'error',
      durationMs: performance.now() - started,
      errorSummary: errorSummary(error),
    });
    throw error;
  }
}
