/** Verifies delta batching, FIFO settlement, failure handling, and projector parity. */

import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { AGENT_TOOL_ARGUMENTS_MAX_BYTES } from '@readtailor/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createAgentRunProjector } from './agent-run-projector';
import { createCoalescingAgentEventSink } from './coalescing-agent-event-sink';

type Deferred = ReturnType<typeof deferred>;
type MessageUpdate = Extract<AgentEvent, { type: 'message_update' }>;

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delta(
  kind: 'text_delta' | 'toolcall_delta',
  value: string,
  options: { index?: number; toolCallId?: string; marker?: string } = {},
): AgentEvent {
  const index = options.index ?? 0;
  const marker = options.marker ?? value;
  const content = Array.from({ length: index + 1 }, (_, current) =>
    kind === 'toolcall_delta' && current === index
      ? {
          type: 'toolCall',
          id: options.toolCallId ?? 'tool',
          name: 'publish',
          arguments: {},
        }
      : { type: 'text', text: marker },
  );
  return {
    type: 'message_update',
    message: { role: 'assistant', content, marker },
    assistantMessageEvent: {
      type: kind,
      contentIndex: index,
      delta: value,
      partial: { role: 'assistant', content, marker },
    },
  } as unknown as AgentEvent;
}

const text = (value: string, marker = value) =>
  delta('text_delta', value, { marker });
const tool = (value: string, index = 0, toolCallId = 'tool') =>
  delta('toolcall_delta', value, { index, toolCallId });
const fence = (id: string): AgentEvent => ({
  type: 'tool_execution_start',
  toolCallId: id,
  toolName: id,
  args: {},
});

function updateOf(event: AgentEvent) {
  if (event.type !== 'message_update') throw new Error('expected message update');
  const update = event.assistantMessageEvent;
  if (update.type !== 'text_delta' && update.type !== 'toolcall_delta') {
    throw new Error('expected delta');
  }
  return update;
}

function controlledSink() {
  let active = 0;
  let maxActive = 0;
  const writes: Array<{ event: AgentEvent; done: Deferred }> = [];
  const eventSink = createCoalescingAgentEventSink({
    sink: async (event) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const done = deferred();
      writes.push({ event, done });
      try {
        await done.promise;
      } finally {
        active -= 1;
      }
    },
  });
  return { eventSink, writes, get maxActive() { return maxActive; } };
}

async function release(
  controlled: ReturnType<typeof controlledSink>,
  index: number,
): Promise<void> {
  await vi.waitFor(() => expect(controlled.writes).toHaveLength(index + 1));
  controlled.writes[index]!.done.resolve();
}

function toolBoundary(
  type: 'toolcall_start' | 'toolcall_end',
  argumentsValue: Record<string, unknown> = {},
): AgentEvent {
  const toolCall = { type: 'toolCall', id: 'tool', name: 'publish', arguments: argumentsValue };
  return {
    type: 'message_update',
    message: { role: 'assistant', content: [toolCall] },
    assistantMessageEvent:
      type === 'toolcall_start'
        ? {
            type,
            contentIndex: 0,
            partial: { role: 'assistant', content: [toolCall] },
          }
        : {
            type,
            contentIndex: 0,
            toolCall,
            partial: { role: 'assistant', content: [toolCall] },
          },
  } as unknown as AgentEvent;
}

describe('Coalescing Agent event sink', () => {
  it('batches adjacent text, retains the latest snapshots, and settles fences FIFO', async () => {
    const controlled = controlledSink();
    const first = text('a');
    const last = text('c', 'latest');
    await controlled.eventSink.accept(first);
    await expect(controlled.eventSink.accept(text('b'))).resolves.toBeUndefined();
    await controlled.eventSink.accept(last);
    const fences = [fence('one'), fence('two')];
    const fencePromises = fences.map((event) => controlled.eventSink.accept(event));
    let flushed = false;
    const flush = controlled.eventSink.flush().then(() => { flushed = true; });

    expect(controlled.writes.map(({ event }) => event)).toEqual([first]);
    await release(controlled, 0);
    await vi.waitFor(() => expect(controlled.writes).toHaveLength(2));
    const merged = controlled.writes[1]!.event as MessageUpdate;
    const lastUpdate = updateOf(last);
    expect(updateOf(merged).delta).toBe('bc');
    expect(merged.message).toBe((last as MessageUpdate).message);
    expect(updateOf(merged).partial).toBe(lastUpdate.partial);
    expect(flushed).toBe(false);

    await release(controlled, 1);
    await release(controlled, 2);
    await release(controlled, 3);
    await Promise.all([...fencePromises, flush]);
    expect(controlled.writes.slice(2).map(({ event }) => event)).toEqual(fences);
    expect(controlled.maxActive).toBe(1);
  });

  it('merges only adjacent compatible Tool deltas without reordering', async () => {
    const controlled = controlledSink();
    const blocker = controlled.eventSink.accept(fence('blocker'));
    await controlled.eventSink.accept(tool('a', 0, 'zero'));
    await controlled.eventSink.accept(tool('b', 0, 'zero'));
    await controlled.eventSink.accept(tool('x', 1, 'one'));
    await controlled.eventSink.accept(tool('c', 0, 'zero'));
    await controlled.eventSink.accept(tool('d', 0, 'other'));

    await release(controlled, 0);
    await blocker;
    for (let index = 1; index <= 4; index += 1) await release(controlled, index);
    await controlled.eventSink.flush();
    expect(controlled.writes.slice(1).map(({ event }) => updateOf(event).delta)).toEqual([
      'ab',
      'x',
      'c',
      'd',
    ]);
  });

  it('stops on the first sink failure and exposes that same failure thereafter', async () => {
    const controlled = controlledSink();
    const failure = new Error('Redis unavailable');
    await controlled.eventSink.accept(text('a'));
    const pendingFence = controlled.eventSink.accept(fence('queued'));
    await controlled.eventSink.accept(text('discarded'));
    const observedFence = expect(pendingFence).rejects.toBe(failure);
    controlled.writes[0]!.done.reject(failure);

    await observedFence;
    await expect(controlled.eventSink.flush()).rejects.toBe(failure);
    await expect(controlled.eventSink.accept(text('later'))).rejects.toBe(failure);
    expect(controlled.writes).toHaveLength(1);
  });
});

describe('Coalescing sink with projector', () => {
  const runId = '00000000-0000-0000-0000-000000000001';

  it('preserves final state while reducing sequences', async () => {
    const events = [
      text('你'),
      text('好'),
      text('！'),
      toolBoundary('toolcall_start'),
      tool('{"value"'),
      tool(':"ok"}'),
      toolBoundary('toolcall_end', { value: 'ok' }),
      {
        type: 'tool_execution_end',
        toolCallId: 'tool',
        toolName: 'publish',
        result: { content: [{ type: 'text', text: 'done' }] },
        isError: false,
      } satisfies AgentEvent,
    ];
    const raw = createAgentRunProjector({ runId, publish: async () => undefined });
    for (const event of events) await raw.accept(event);

    let gate: Deferred | undefined;
    const sequences: number[] = [];
    const projected = createAgentRunProjector({
      runId,
      publish: async ({ snapshot, event }) => {
        if (event) {
          sequences.push(event.sequence);
          expect(event.sequence).toBe(snapshot.lastSequence);
        }
        const current = gate;
        gate = undefined;
        await current?.promise;
      },
    });
    const sink = createCoalescingAgentEventSink({ sink: (event) => projected.accept(event) });

    let blocked = deferred();
    gate = blocked;
    for (const event of events.slice(0, 3)) await sink.accept(event);
    blocked.resolve();
    await sink.accept(events[3]!);
    blocked = deferred();
    gate = blocked;
    await sink.accept(events[4]!);
    await sink.accept(events[5]!);
    blocked.resolve();
    for (const event of events.slice(6)) await sink.accept(event);
    await sink.flush();

    const { lastSequence: rawSequence, ...rawState } = raw.snapshot;
    const { lastSequence, ...projectedState } = projected.snapshot;
    expect(projectedState).toEqual(rawState);
    expect(lastSequence).toBeLessThan(rawSequence);
    expect(sequences).toEqual(Array.from({ length: lastSequence }, (_, index) => index + 1));
  });

  it('enforces the Tool argument limit after pending deltas merge', async () => {
    const publish = deferred();
    let publishes = 0;
    const projector = createAgentRunProjector({
      runId,
      publish: async () => {
        publishes += 1;
        if (publishes === 1) await publish.promise;
      },
    });
    const sink = createCoalescingAgentEventSink({ sink: (event) => projector.accept(event) });
    const start = sink.accept(toolBoundary('toolcall_start'));
    const chunk = 'x'.repeat(Math.floor(AGENT_TOOL_ARGUMENTS_MAX_BYTES / 2) + 1);
    await sink.accept(tool(chunk));
    await sink.accept(tool(chunk));
    publish.resolve();

    await start;
    await expect(sink.flush()).rejects.toThrow('arguments 超过');
    expect(publishes).toBe(1);
  });
});
