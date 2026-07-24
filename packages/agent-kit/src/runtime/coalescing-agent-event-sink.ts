/** Coalesces adjacent streaming deltas while serializing all Agent event projection. */

import type { AgentEvent } from '@earendil-works/pi-agent-core';

type MessageUpdateEvent = Extract<AgentEvent, { type: 'message_update' }>;
type AssistantMessageEvent = MessageUpdateEvent['assistantMessageEvent'];
type TextDelta = Extract<AssistantMessageEvent, { type: 'text_delta' }>;
type ToolCallDelta = Extract<AssistantMessageEvent, { type: 'toolcall_delta' }>;
type MergeableDelta = TextDelta | ToolCallDelta;

type MergeKey =
  | { kind: 'text'; contentIndex: number }
  | { kind: 'toolcall'; contentIndex: number; toolCallId: string | null };

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

type QueueItem =
  | {
      kind: 'event';
      event: AgentEvent;
      mergeKey: MergeKey | null;
      waiter?: Deferred;
    }
  | {
      kind: 'barrier';
      waiter: Deferred;
    };

export interface CoalescingAgentEventSink {
  accept(event: AgentEvent): Promise<void>;
  flush(): Promise<void>;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function extractMergeKey(event: AgentEvent): MergeKey | null {
  if (event.type !== 'message_update' || event.message.role !== 'assistant') return null;
  const update = event.assistantMessageEvent;
  if (update.type === 'text_delta') {
    return { kind: 'text', contentIndex: update.contentIndex };
  }
  if (update.type !== 'toolcall_delta') return null;
  const content = update.partial.content[update.contentIndex];
  const toolCallId =
    content?.type === 'toolCall' && content.id.length > 0 ? content.id : null;
  return { kind: 'toolcall', contentIndex: update.contentIndex, toolCallId };
}

function compatibleMergeKey(previous: MergeKey, next: MergeKey): boolean {
  if (previous.kind !== next.kind || previous.contentIndex !== next.contentIndex) return false;
  if (previous.kind === 'text' || next.kind === 'text') return true;
  return (
    previous.toolCallId === null ||
    next.toolCallId === null ||
    previous.toolCallId === next.toolCallId
  );
}

function mergedKey(previous: MergeKey, next: MergeKey): MergeKey {
  if (previous.kind === 'text' || next.kind === 'text') return next;
  return {
    ...next,
    toolCallId: next.toolCallId ?? previous.toolCallId,
  };
}

function mergeEvents(previous: AgentEvent, next: AgentEvent): AgentEvent {
  const previousUpdate = (previous as MessageUpdateEvent).assistantMessageEvent as MergeableDelta;
  const nextMessageUpdate = next as MessageUpdateEvent;
  const nextUpdate = nextMessageUpdate.assistantMessageEvent as MergeableDelta;
  return {
    ...nextMessageUpdate,
    assistantMessageEvent: {
      ...nextUpdate,
      delta: previousUpdate.delta + nextUpdate.delta,
    },
  } as AgentEvent;
}

export function createCoalescingAgentEventSink(options: {
  sink(event: AgentEvent): Promise<void>;
}): CoalescingAgentEventSink {
  const pendingQueue: QueueItem[] = [];
  let pumping = false;
  let failed = false;
  let failure: unknown;

  const rejectItem = (item: QueueItem, error: unknown) => {
    if (item.kind === 'barrier') {
      item.waiter.reject(error);
      return;
    }
    item.waiter?.reject(error);
  };

  const enterFailureState = (error: unknown, activeItem?: QueueItem) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
    if (activeItem) rejectItem(activeItem, failure);
    for (const item of pendingQueue.splice(0)) rejectItem(item, failure);
  };

  const runPump = async () => {
    let activeItem: QueueItem | undefined;
    try {
      while ((activeItem = pendingQueue.shift())) {
        if (activeItem.kind === 'barrier') {
          activeItem.waiter.resolve();
          activeItem = undefined;
          continue;
        }
        await options.sink(activeItem.event);
        activeItem.waiter?.resolve();
        activeItem = undefined;
      }
    } catch (error) {
      enterFailureState(error, activeItem);
    } finally {
      pumping = false;
      if (!failed && pendingQueue.length > 0) startPump();
    }
  };

  function startPump(): void {
    if (pumping || failed || pendingQueue.length === 0) return;
    pumping = true;
    void runPump();
  }

  const rejectedWithFailure = () => Promise.reject(failure);

  return {
    accept(event: AgentEvent): Promise<void> {
      if (failed) return rejectedWithFailure();

      const mergeKey = extractMergeKey(event);
      if (mergeKey) {
        const tail = pendingQueue.at(-1);
        if (
          tail?.kind === 'event' &&
          tail.mergeKey &&
          compatibleMergeKey(tail.mergeKey, mergeKey)
        ) {
          tail.event = mergeEvents(tail.event, event);
          tail.mergeKey = mergedKey(tail.mergeKey, mergeKey);
        } else {
          pendingQueue.push({ kind: 'event', event, mergeKey });
        }
        startPump();
        return Promise.resolve();
      }

      const waiter = createDeferred();
      pendingQueue.push({ kind: 'event', event, mergeKey: null, waiter });
      startPump();
      return waiter.promise;
    },

    flush(): Promise<void> {
      if (failed) return rejectedWithFailure();
      const waiter = createDeferred();
      pendingQueue.push({ kind: 'barrier', waiter });
      startPump();
      return waiter.promise;
    },
  };
}
