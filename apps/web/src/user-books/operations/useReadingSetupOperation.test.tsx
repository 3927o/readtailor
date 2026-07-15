// @vitest-environment happy-dom
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReadingSetupOperationResponse } from '@readtailor/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../apiError';
import {
  useReadingSetupOperation,
  type ReadingSetupOperationAdapter,
} from './useReadingSetupOperation';
import type { ReadingSetupStreamEnvelope } from './eventFence';

const apiMocks = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  getExact: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('../api/operations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/operations')>();
  return {
    ...actual,
    getCurrentReadingSetupOperation: apiMocks.getCurrent,
    getReadingSetupOperation: apiMocks.getExact,
    resumeReadingSetupOperation: apiMocks.resume,
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface TestResult {
  id: string;
}

interface TestEvent extends ReadingSetupStreamEnvelope {
  type: 'progress' | 'final' | 'error';
  result?: TestResult;
}

interface TestCommand {
  value: string;
  idempotencyKey: string;
}

interface TestState {
  mode: 'idle' | 'streaming' | 'recovering' | 'failed' | 'completed';
  operationId: string | null;
  result: TestResult | null;
  error: string | null;
}

type TestAction =
  | { type: 'begin' }
  | { type: 'event'; event: TestEvent }
  | { type: 'recover'; message?: string }
  | { type: 'failed'; message: string }
  | { type: 'complete'; result: TestResult }
  | { type: 'reset' };

const initialState: TestState = {
  mode: 'idle',
  operationId: null,
  result: null,
  error: null,
};

function reduce(state: TestState, action: TestAction): TestState {
  switch (action.type) {
    case 'begin': return { ...initialState, mode: 'streaming' };
    case 'recover': return { ...state, mode: 'recovering', error: action.message ?? null };
    case 'failed': return { ...state, mode: 'failed', error: action.message };
    case 'complete': return { ...state, mode: 'completed', result: action.result, error: null };
    case 'reset': return initialState;
    case 'event':
      if (action.event.type === 'final' && action.event.result) {
        return {
          ...state,
          mode: 'completed',
          operationId: action.event.operationId,
          result: action.event.result,
        };
      }
      return {
        ...state,
        operationId: action.event.operationId,
        mode: action.event.type === 'error' ? 'recovering' : state.mode,
        error: action.event.type === 'error' ? 'stream error' : state.error,
      };
  }
}

function operation(
  status: 'pending' | 'running' | 'completed' | 'failed',
  overrides: Partial<ReadingSetupOperationResponse> = {},
): ReadingSetupOperationResponse {
  const outcome = status === 'completed'
    ? { resultDraftId: 'result-1', resultTrialRevisionId: null, errorSummary: null, recoverableInput: null }
    : status === 'failed'
      ? { resultDraftId: null, resultTrialRevisionId: null, errorSummary: 'operation failed', recoverableInput: { feedback: 'saved feedback' } }
      : { resultDraftId: null, resultTrialRevisionId: null, errorSummary: null, recoverableInput: { feedback: 'saved feedback' } };
  return {
    operationId: 'operation-1',
    operationAttempt: 1,
    kind: 'strategy_revision',
    source: 'strategy_feedback',
    baseDraftId: 'base-1',
    baseTrialRevisionId: null,
    status,
    canResume: status === 'running',
    ...outcome,
    ...overrides,
  } as ReadingSetupOperationResponse;
}

const roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  apiMocks.getCurrent.mockReset().mockResolvedValue(null);
  apiMocks.getExact.mockReset().mockResolvedValue(null);
  apiMocks.resume.mockReset();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function createAdapter(overrides: Partial<ReadingSetupOperationAdapter<
  TestState,
  TestAction,
  { value: string },
  TestCommand,
  TestEvent,
  TestResult,
  string
>> = {}) {
  const applyCompleted = vi.fn().mockResolvedValue(undefined);
  const loadCompleted = vi.fn().mockResolvedValue({ id: 'loaded-result' });
  const stream = vi.fn().mockResolvedValue(undefined);
  const adapter: ReadingSetupOperationAdapter<
    TestState,
    TestAction,
    { value: string },
    TestCommand,
    TestEvent,
    TestResult,
    string
  > = {
    machine: {
      initialState,
      reduce,
      begin: () => ({ type: 'begin' }),
      beginRecovery: () => ({ type: 'begin' }),
      event: (event) => ({ type: 'event', event }),
      recover: (message) => ({ type: 'recover', ...(message ? { message } : {}) }),
      failed: (message) => ({ type: 'failed', message }),
      complete: (result) => ({ type: 'complete', result }),
      reset: () => ({ type: 'reset' }),
      mode: (state) => state.mode,
      operationId: (state) => state.operationId,
      error: (state) => state.error,
    },
    commandKey: (input) => input.value,
    createCommand: (input, idempotencyKey) => ({ ...input, idempotencyKey }),
    stream,
    matchesOperation: (value) => value.kind === 'strategy_revision'
      && value.source === 'strategy_feedback'
      && value.baseDraftId === 'base-1',
    resultFromEvent: (event, state) => event.type === 'final' ? state.result : null,
    isErrorEvent: (event) => event.type === 'error',
    loadCompleted,
    resultKey: (result) => result.id,
    applyCompleted,
    recoverableInput: (value) => value.recoverableInput?.feedback ?? null,
    failureMessage: (value) => value.errorSummary ?? 'failed',
    conflictMessage: 'conflict',
    ...overrides,
  };
  return { adapter, applyCompleted, loadCompleted, stream };
}

function renderOperation(
  adapter: ReturnType<typeof createAdapter>['adapter'],
  options: {
    baseKey?: string;
    strict?: boolean;
    onRecoverableInput?: (input: string) => void;
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latest: ReturnType<typeof useReadingSetupOperation<
    TestState,
    TestAction,
    { value: string },
    TestCommand,
    TestEvent,
    TestResult,
    string
  >> | null = null;

  function Harness({ baseKey, userBookId }: { baseKey: string; userBookId: string }) {
    latest = useReadingSetupOperation({
      userBookId,
      baseKey,
      enabled: true,
      adapter,
      ...(options.onRecoverableInput ? { onRecoverableInput: options.onRecoverableInput } : {}),
    });
    return null;
  }

  const host = document.createElement('div');
  const root = createRoot(host);
  roots.push(root);
  const render = async (baseKey = options.baseKey ?? 'base-1', userBookId = 'book-1') => {
    await act(async () => {
      const content = <QueryClientProvider client={queryClient}><Harness baseKey={baseKey} userBookId={userBookId} /></QueryClientProvider>;
      root.render(options.strict ? <StrictMode>{content}</StrictMode> : content);
    });
  };
  return {
    queryClient,
    render,
    value: () => latest!,
  };
}

async function waitFor(assertion: () => void | Promise<void>) {
  await act(async () => {
    await vi.waitFor(assertion);
  });
}

describe('useReadingSetupOperation', () => {
  it('commits a direct stream result', async () => {
    const fixture = createAdapter();
    fixture.stream.mockImplementation(async (_command, onEvent) => {
      onEvent({ operationId: 'operation-1', operationAttempt: 1, sequence: 1, speculativeEpoch: 1, type: 'progress' });
      onEvent({ operationId: 'operation-1', operationAttempt: 1, sequence: 2, type: 'final', result: { id: 'direct' } });
    });
    const hook = renderOperation(fixture.adapter);
    await hook.render();

    act(() => hook.value().submit({ value: 'same input' }));

    await waitFor(() => expect(hook.value().state).toMatchObject({ mode: 'completed', result: { id: 'direct' } }));
    expect(fixture.applyCompleted).toHaveBeenCalledWith({ id: 'direct' });
  });

  it('reuses the command idempotency key after a transport failure', async () => {
    const commands: TestCommand[] = [];
    const fixture = createAdapter();
    fixture.stream
      .mockImplementationOnce(async (command) => {
        commands.push(command);
        throw new ApiError('disconnected', 0);
      })
      .mockImplementationOnce(async (command, onEvent) => {
        commands.push(command);
        onEvent({ operationId: 'operation-1', operationAttempt: 1, sequence: 1, type: 'final', result: { id: 'retry' } });
      });
    const hook = renderOperation(fixture.adapter);
    await hook.render();
    act(() => hook.value().submit({ value: 'same input' }));
    await waitFor(() => expect(hook.value().state.mode).toBe('recovering'));

    act(() => hook.value().submit({ value: 'same input' }));
    await waitFor(() => expect(hook.value().state.mode).toBe('completed'));

    expect(commands[0]?.idempotencyKey).toBe(commands[1]?.idempotencyKey);
  });

  it('resumes a disconnected operation once and loads its completed result', async () => {
    let currentReads = 0;
    apiMocks.getCurrent.mockImplementation(() => {
      currentReads += 1;
      if (currentReads === 1) return Promise.resolve(null);
      return Promise.resolve(apiMocks.resume.mock.calls.length
        ? operation('completed')
        : operation('running'));
    });
    apiMocks.resume.mockResolvedValue(operation('running', { canResume: false }));
    const fixture = createAdapter({
      stream: vi.fn().mockRejectedValue(new ApiError('disconnected', 0)),
    });
    const hook = renderOperation(fixture.adapter);
    await hook.render();
    act(() => hook.value().submit({ value: 'recover me' }));

    await waitFor(() => expect(apiMocks.resume).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(hook.value().state.mode).toBe('completed'));
    expect(fixture.loadCompleted).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('loads an already completed current operation on mount', async () => {
    apiMocks.getCurrent.mockResolvedValue(operation('completed'));
    const fixture = createAdapter();
    const hook = renderOperation(fixture.adapter, { strict: true });
    await hook.render();

    await waitFor(() => expect(apiMocks.getCurrent).toHaveBeenCalled());
    await expect(apiMocks.getCurrent.mock.results.at(-1)?.value).resolves.toMatchObject({ status: 'completed' });
    await waitFor(() => expect(hook.value().operation).toMatchObject({ status: 'completed' }));
    await waitFor(() => expect(hook.value().state.mode).toBe('completed'));
    expect(fixture.loadCompleted).toHaveBeenCalledTimes(1);
  });

  it('restores recoverable input and exposes a failed operation', async () => {
    apiMocks.getCurrent.mockResolvedValue(operation('failed'));
    const recovered = vi.fn();
    const fixture = createAdapter();
    const hook = renderOperation(fixture.adapter, { onRecoverableInput: recovered });
    await hook.render();

    await waitFor(() => expect(apiMocks.getCurrent).toHaveBeenCalled());
    await expect(apiMocks.getCurrent.mock.results.at(-1)?.value).resolves.toMatchObject({ status: 'failed' });
    await waitFor(() => expect(hook.value().operation).toMatchObject({ status: 'failed' }));
    await waitFor(() => expect(hook.value().state).toMatchObject({ mode: 'failed', error: 'operation failed' }));
    expect(recovered).toHaveBeenCalledWith('saved feedback');
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it('ignores a current operation whose base does not match', async () => {
    apiMocks.getCurrent.mockResolvedValue(operation('running', { baseDraftId: 'other-base' }));
    const fixture = createAdapter();
    const hook = renderOperation(fixture.adapter);
    await hook.render();

    await waitFor(() => expect(apiMocks.getCurrent).toHaveBeenCalled());
    expect(hook.value().state.mode).toBe('idle');
    expect(apiMocks.resume).not.toHaveBeenCalled();
    expect(fixture.loadCompleted).not.toHaveBeenCalled();
  });

  it('resets active state when the base key changes', async () => {
    let lateEvent: ((event: TestEvent) => void) | null = null;
    const fixture = createAdapter({
      stream: vi.fn((_command, onEvent) => {
        lateEvent = onEvent;
        return new Promise<void>(() => {});
      }),
    });
    const hook = renderOperation(fixture.adapter);
    await hook.render('base-1');
    act(() => hook.value().submit({ value: 'active' }));
    await waitFor(() => expect(hook.value().state.mode).toBe('streaming'));

    await hook.render('base-2');

    await waitFor(() => expect(hook.value().state.mode).toBe('idle'));
    act(() => {
      lateEvent!({
        operationId: 'operation-1',
        operationAttempt: 1,
        sequence: 1,
        type: 'final',
        result: { id: 'late-stream-result' },
      });
    });
    expect(hook.value().state.mode).toBe('idle');
    expect(fixture.applyCompleted).not.toHaveBeenCalled();
  });

  it('drops a deferred completed result after the base key changes', async () => {
    apiMocks.getCurrent.mockResolvedValue(operation('completed'));
    let expectedBase = 'base-1';
    let resolveLoad: ((result: TestResult) => void) | null = null;
    const loadCompleted = vi.fn(() => new Promise<TestResult>((resolve) => { resolveLoad = resolve; }));
    const fixture = createAdapter({
      matchesOperation: (value) => value.baseDraftId === expectedBase,
      loadCompleted,
    });
    const hook = renderOperation(fixture.adapter);
    await hook.render('base-1');
    await waitFor(() => expect(hook.value().operation).toMatchObject({ status: 'completed' }));
    await waitFor(() => expect(loadCompleted).toHaveBeenCalledTimes(1));

    expectedBase = 'base-2';
    await hook.render('base-2');
    await waitFor(() => expect(hook.value().state.mode).toBe('idle'));
    await act(async () => {
      resolveLoad!({ id: 'late-loaded-result' });
      await Promise.resolve();
    });

    expect(hook.value().state.mode).toBe('idle');
    expect(fixture.applyCompleted).not.toHaveBeenCalled();
  });

  it('resets active state when the user book changes with the same base key', async () => {
    let lateEvent: ((event: TestEvent) => void) | null = null;
    const fixture = createAdapter({
      stream: vi.fn((_command, onEvent) => {
        lateEvent = onEvent;
        return new Promise<void>(() => {});
      }),
    });
    const hook = renderOperation(fixture.adapter);
    await hook.render('base-1', 'book-1');
    act(() => hook.value().submit({ value: 'active' }));
    await waitFor(() => expect(hook.value().state.mode).toBe('streaming'));

    await hook.render('base-1', 'book-2');
    await waitFor(() => expect(hook.value().state.mode).toBe('idle'));
    act(() => {
      lateEvent!({
        operationId: 'operation-1',
        operationAttempt: 1,
        sequence: 1,
        type: 'final',
        result: { id: 'late-cross-book-result' },
      });
    });

    expect(hook.value().state.mode).toBe('idle');
    expect(fixture.applyCompleted).not.toHaveBeenCalled();
  });

  it('uses the adapter conflict message and invalidates canonical caches after 409', async () => {
    const fixture = createAdapter({ stream: vi.fn().mockRejectedValue(new ApiError('stale', 409)) });
    const hook = renderOperation(fixture.adapter);
    hook.queryClient.setQueryData(['user-book', 'book-1'], { id: 'book-1' });
    hook.queryClient.setQueryData(['user-book', 'book-1', 'strategy', 'draft-1'], { id: 'draft-1' });
    await hook.render();

    act(() => hook.value().submit({ value: 'conflict' }));

    await waitFor(() => expect(hook.value().state).toMatchObject({ mode: 'recovering', error: 'conflict' }));
    expect(hook.queryClient.getQueryState(['user-book', 'book-1'])?.isInvalidated).toBe(true);
    expect(hook.queryClient.getQueryState(['user-book', 'book-1', 'strategy', 'draft-1'])?.isInvalidated).toBe(true);
  });

  it('resumes at most once per attempt under StrictMode', async () => {
    let attempt = 1;
    apiMocks.getCurrent.mockImplementation(() => Promise.resolve(operation('running', {
      operationAttempt: attempt,
    })));
    apiMocks.resume.mockResolvedValue(operation('running', { canResume: false }));
    const fixture = createAdapter();
    const hook = renderOperation(fixture.adapter, { strict: true });
    await hook.render();

    await waitFor(() => expect(hook.value().operation).toMatchObject({
      status: 'running',
      operationAttempt: 1,
    }));
    await waitFor(() => expect(apiMocks.resume).toHaveBeenCalledTimes(1));
    await act(async () => {
      await hook.queryClient.invalidateQueries({ queryKey: ['user-book', 'book-1', 'reading-setup-operation'] });
    });
    expect(apiMocks.resume).toHaveBeenCalledTimes(1);

    attempt = 2;
    await act(async () => {
      await hook.queryClient.invalidateQueries({ queryKey: ['user-book', 'book-1', 'reading-setup-operation'] });
    });
    await waitFor(() => expect(apiMocks.resume).toHaveBeenCalledTimes(2));
  });
});
