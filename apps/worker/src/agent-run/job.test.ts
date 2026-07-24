/** Verifies Agent run tail settlement, terminal ordering, and retry isolation. */

import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AgentRunJobPayload } from '@readtailor/contracts';
import type { AgentRunJobProgress, AgentRunQueueJob } from '@readtailor/queue';
import { describe, expect, it, vi } from 'vitest';
import { executeAgentRun, failAgentRun } from './job';
import { createAgentHandlerRegistry, type AgentRunHandler } from './registry';

type Deferred = ReturnType<typeof deferred>;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function text(delta: string): AgentEvent {
  return {
    type: 'message_update',
    message: { role: 'assistant', content: [{ type: 'text', text: delta }] },
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta,
      partial: { role: 'assistant', content: [{ type: 'text', text: delta }] },
    },
  } as unknown as AgentEvent;
}

const payload: AgentRunJobPayload = {
  agentType: 'test',
  sessionId: '00000000-0000-0000-0000-000000000001',
  runId: '00000000-0000-0000-0000-000000000002',
  input: null,
};

function fixture(options: {
  execute: AgentRunHandler['execute'];
  update?: (progress: AgentRunJobProgress) => Promise<void>;
  fail?: AgentRunHandler['fail'];
}) {
  const updates: AgentRunJobProgress[] = [];
  const value = {
    data: payload,
    progress: 0 as unknown,
    updateProgress: async (progress: unknown) => {
      const typed = progress as AgentRunJobProgress;
      updates.push(typed);
      value.progress = typed;
      await options.update?.(typed);
    },
  };
  const registry = createAgentHandlerRegistry([{
    agentType: payload.agentType,
    execute: options.execute,
    fail: options.fail ?? (async () => 'cleared'),
  }]);
  return { registry, job: value as unknown as AgentRunQueueJob, updates };
}

const events = (updates: AgentRunJobProgress[]) =>
  updates.flatMap(({ event }) => event ? [event] : []);

describe('Agent run job', () => {
  it('coalesces and drains the tail before run completion', async () => {
    const gates: Deferred[] = [];
    let active = 0;
    let maxActive = 0;
    const state = fixture({
      execute: async ({ emit }) => {
        await emit(text('a'));
        await emit(text('b'));
        await emit(text('c'));
        return 'committed';
      },
      update: async (progress) => {
        if (progress.event?.type !== 'assistant_text_delta') return;
        active += 1;
        maxActive = Math.max(maxActive, active);
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
        active -= 1;
      },
    });
    let settled = false;
    const execution = executeAgentRun(state).finally(() => { settled = true; });

    await vi.waitFor(() => expect(gates).toHaveLength(1));
    gates[0]!.resolve();
    await vi.waitFor(() => expect(gates).toHaveLength(2));
    expect(settled).toBe(false);
    expect(events(state.updates).some(({ type }) => type === 'run_finished')).toBe(false);
    gates[1]!.resolve();
    await execution;

    expect(maxActive).toBe(1);
    expect(events(state.updates)).toMatchObject([
      { type: 'assistant_text_delta', sequence: 1, delta: 'a' },
      { type: 'assistant_text_delta', sequence: 2, delta: 'bc' },
      { type: 'run_finished', sequence: 3, status: 'completed' },
    ]);
    expect(state.updates.at(-1)?.snapshot).toMatchObject({
      status: 'completed',
      assistantText: 'abc',
    });
  });

  it('drains stale and exceptional handlers before returning control', async () => {
    const staleGate = deferred();
    const stale = fixture({
      execute: async ({ emit }) => {
        await emit(text('stale'));
        return 'stale';
      },
      update: async (progress) => {
        if (progress.event) await staleGate.promise;
      },
    });
    const staleExecution = executeAgentRun(stale);
    await vi.waitFor(() => expect(events(stale.updates)).toHaveLength(1));
    staleGate.resolve();
    await staleExecution;
    expect(events(stale.updates).map(({ type }) => type)).toEqual(['assistant_text_delta']);

    const handlerError = new Error('handler failed');
    const failureGate = deferred();
    const failed = fixture({
      execute: async ({ emit }) => {
        await emit(text('partial'));
        throw handlerError;
      },
      update: async (progress) => {
        if (progress.event) await failureGate.promise;
      },
    });
    const failedExecution = executeAgentRun(failed).catch((error: unknown) => error);
    await vi.waitFor(() => expect(events(failed.updates)).toHaveLength(1));
    failureGate.resolve();
    await expect(failedExecution).resolves.toBe(handlerError);
    await failAgentRun({ ...failed, error: handlerError });
    expect(events(failed.updates).at(-1)).toMatchObject({
      type: 'run_finished',
      status: 'failed',
    });
  });

  it('propagates a write failure and gives the retry a fresh sink', async () => {
    let attempt = 0;
    const execute: AgentRunHandler['execute'] = async ({ emit }) => {
      attempt += 1;
      await emit(text(`attempt-${attempt}`));
      return 'committed';
    };
    const writeError = new Error('Redis failed');
    const first = fixture({
      execute,
      update: async (progress) => {
        if (progress.event) throw writeError;
      },
    });
    await expect(executeAgentRun(first)).rejects.toBe(writeError);
    expect(events(first.updates)).toHaveLength(1);

    const retry = fixture({ execute });
    await executeAgentRun(retry);
    expect(retry.updates.at(-1)?.snapshot).toMatchObject({
      status: 'completed',
      assistantText: 'attempt-2',
    });
  });
});
