import { useCallback, useEffect, useReducer, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReadingSetupOperationResponse } from '@readtailor/contracts';
import {
  ApiError,
  getCurrentReadingSetupOperation,
  getReadingSetupOperation,
  resumeReadingSetupOperation,
} from '../api';
import { userBookQueryKeys } from '../queryKeys';
import {
  advanceReadingSetupEventFence,
  EMPTY_READING_SETUP_EVENT_FENCE,
  type ReadingSetupStreamEnvelope,
} from './eventFence';

type OperationMode = 'idle' | 'streaming' | 'selecting' | 'recovering' | 'failed' | 'completed';

export interface ReadingSetupOperationMachine<State, Action, Command, Event, Result> {
  initialState: State;
  reduce(state: State, action: Action): State;
  begin(command: Command): Action;
  beginRecovery(): Action;
  event(event: Event): Action;
  recover(message?: string): Action;
  failed(message: string): Action;
  complete(result: Result): Action;
  reset(): Action;
  mode(state: State): OperationMode;
  operationId(state: State): string | null;
  error(state: State): string | null;
}

export interface ReadingSetupOperationAdapter<
  State,
  Action,
  Input,
  Command,
  Event extends ReadingSetupStreamEnvelope,
  Result,
  Recoverable,
> {
  machine: ReadingSetupOperationMachine<State, Action, Command, Event, Result>;
  commandKey(input: Input): string;
  createCommand(input: Input, idempotencyKey: string): Command;
  stream(command: Command, onEvent: (event: Event) => void): Promise<void>;
  matchesOperation(operation: ReadingSetupOperationResponse): boolean;
  resultFromEvent(event: Event, state: State): Result | null;
  isErrorEvent(event: Event): boolean;
  loadCompleted(operation: ReadingSetupOperationResponse): Promise<Result>;
  resultKey(result: Result): string;
  applyCompleted(result: Result): Promise<void>;
  recoverableInput(operation: ReadingSetupOperationResponse): Recoverable | null;
  failureMessage(operation: ReadingSetupOperationResponse): string;
  conflictMessage: string;
}

export function useReadingSetupOperation<
  State,
  Action,
  Input,
  Command,
  Event extends ReadingSetupStreamEnvelope,
  Result,
  Recoverable,
>(options: {
  userBookId: string;
  baseKey: string;
  enabled: boolean;
  adapter: ReadingSetupOperationAdapter<State, Action, Input, Command, Event, Result, Recoverable>;
  onCompleted?(result: Result): void;
  onRecoverableInput?(input: Recoverable): void;
}) {
  const queryClient = useQueryClient();
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [state, dispatch] = useReducer(options.adapter.machine.reduce, options.adapter.machine.initialState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const commandRef = useRef<{ key: string; command: Command } | null>(null);
  const activeBaseKey = useRef<string | null>(null);
  const resumedAttempts = useRef(new Set<string>());
  const loadingResults = useRef(new Set<string>());
  const completedResults = useRef(new Set<string>());
  const deliveredRecoverableInputs = useRef(new Set<string>());
  const eventFence = useRef(EMPTY_READING_SETUP_EVENT_FENCE);

  const dispatchTracked = useCallback((action: Action) => {
    const next = optionsRef.current.adapter.machine.reduce(stateRef.current, action);
    stateRef.current = next;
    dispatch(action);
    return next;
  }, []);

  const resync = useCallback(async () => {
    const userBookId = optionsRef.current.userBookId;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.detail(userBookId) }),
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.strategies(userBookId) }),
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.trials(userBookId) }),
      queryClient.invalidateQueries({ queryKey: userBookQueryKeys.readingSetupOperations(userBookId) }),
    ]);
  }, [queryClient]);

  const complete = useCallback(async (result: Result) => {
    const current = optionsRef.current;
    const key = current.adapter.resultKey(result);
    if (completedResults.current.has(key)) return;
    completedResults.current.add(key);
    dispatchTracked(current.adapter.machine.complete(result));
    commandRef.current = null;
    current.onCompleted?.(result);
    await current.adapter.applyCompleted(result);
    await queryClient.invalidateQueries({
      queryKey: userBookQueryKeys.readingSetupOperations(current.userBookId),
    });
  }, [dispatchTracked, queryClient]);

  const deliverRecoverableInput = useCallback((operation: ReadingSetupOperationResponse) => {
    const current = optionsRef.current;
    const recoverable = current.adapter.recoverableInput(operation);
    if (recoverable === null) return;
    const key = `${operation.operationId}:${operation.operationAttempt}`;
    if (deliveredRecoverableInputs.current.has(key)) return;
    deliveredRecoverableInputs.current.add(key);
    current.onRecoverableInput?.(recoverable);
  }, []);

  const handleEvent = useCallback((event: Event) => {
    const nextFence = advanceReadingSetupEventFence(eventFence.current, event);
    if (!nextFence) return;
    eventFence.current = nextFence;
    const current = optionsRef.current;
    const nextState = dispatchTracked(current.adapter.machine.event(event));
    const result = current.adapter.resultFromEvent(event, nextState);
    if (result) {
      void complete(result);
    } else if (current.adapter.isErrorEvent(event)) {
      void queryClient.invalidateQueries({
        queryKey: userBookQueryKeys.readingSetupOperations(current.userBookId),
      });
    }
  }, [complete, dispatchTracked, queryClient]);

  const stream = useMutation<void, Error, Command>({
    mutationFn: (command) => optionsRef.current.adapter.stream(command, handleEvent),
    onMutate: (command) => {
      activeBaseKey.current = optionsRef.current.baseKey;
      eventFence.current = EMPTY_READING_SETUP_EVENT_FENCE;
      dispatchTracked(optionsRef.current.adapter.machine.begin(command));
    },
    onError: (error) => {
      const current = optionsRef.current;
      dispatchTracked(current.adapter.machine.recover(
        error instanceof ApiError && error.status === 409
          ? current.adapter.conflictMessage
          : error.message,
      ));
      void resync();
    },
  });

  const mode = options.adapter.machine.mode(state);
  const operationId = options.adapter.machine.operationId(state);
  const currentOperation = useQuery({
    queryKey: userBookQueryKeys.currentReadingSetupOperation(options.userBookId),
    queryFn: () => getCurrentReadingSetupOperation(options.userBookId),
    enabled: options.enabled && !operationId,
    refetchInterval: mode === 'recovering' ? 1000 : false,
  });
  const operationDetail = useQuery({
    queryKey: userBookQueryKeys.readingSetupOperation(
      options.userBookId,
      operationId ?? 'pending',
    ),
    queryFn: () => getReadingSetupOperation(options.userBookId, operationId!),
    enabled: options.enabled && mode === 'recovering' && Boolean(operationId),
    refetchInterval: (query) => ['pending', 'running'].includes(query.state.data?.status ?? '')
      ? 1000
      : false,
  });
  const observedOperation = operationId ? operationDetail.data : currentOperation.data;

  const resume = useMutation({
    mutationFn: (targetOperationId: string) => resumeReadingSetupOperation(
      optionsRef.current.userBookId,
      targetOperationId,
    ),
    onSuccess: (operation) => {
      const userBookId = optionsRef.current.userBookId;
      queryClient.setQueryData(
        userBookQueryKeys.readingSetupOperation(userBookId, operation.operationId),
        operation,
      );
      void queryClient.invalidateQueries({
        queryKey: userBookQueryKeys.readingSetupOperations(userBookId),
      });
    },
    onError: () => void resync(),
  });

  useEffect(() => {
    if (mode === 'idle' || !activeBaseKey.current || activeBaseKey.current === options.baseKey) return;
    commandRef.current = null;
    activeBaseKey.current = null;
    eventFence.current = EMPTY_READING_SETUP_EVENT_FENCE;
    dispatchTracked(optionsRef.current.adapter.machine.reset());
  }, [dispatchTracked, mode, options.baseKey]);

  useEffect(() => {
    const operation = currentOperation.data;
    const current = optionsRef.current;
    if (!current.enabled || mode !== 'idle' || !operation || !current.adapter.matchesOperation(operation)) return;
    activeBaseKey.current = current.baseKey;
    dispatchTracked(current.adapter.machine.beginRecovery());
    dispatchTracked(current.adapter.machine.recover());
    deliverRecoverableInput(operation);
  }, [
    currentOperation.data,
    deliverRecoverableInput,
    dispatchTracked,
    mode,
    options.baseKey,
    options.enabled,
  ]);

  useEffect(() => {
    const operation = observedOperation;
    const current = optionsRef.current;
    if (!current.enabled || mode !== 'recovering' || !operation || !current.adapter.matchesOperation(operation)) return;

    deliverRecoverableInput(operation);
    if (operation.status === 'completed') {
      const loadKey = `${operation.operationId}:${operation.operationAttempt}`;
      if (loadingResults.current.has(loadKey)) return;
      loadingResults.current.add(loadKey);
      void current.adapter.loadCompleted(operation)
        .then(complete)
        .catch(() => void resync())
        .finally(() => loadingResults.current.delete(loadKey));
      return;
    }
    if (operation.status === 'failed') {
      commandRef.current = null;
      dispatchTracked(current.adapter.machine.failed(current.adapter.failureMessage(operation)));
      return;
    }
    if (operation.canResume) {
      const attemptKey = `${operation.operationId}:${operation.operationAttempt}`;
      if (!resumedAttempts.current.has(attemptKey)) {
        resumedAttempts.current.add(attemptKey);
        resume.mutate(operation.operationId);
      }
    }
  }, [
    complete,
    deliverRecoverableInput,
    dispatchTracked,
    mode,
    observedOperation,
    options.enabled,
    resync,
  ]);

  const submit = (input: Input) => {
    const current = optionsRef.current;
    const currentMode = current.adapter.machine.mode(stateRef.current);
    const key = current.adapter.commandKey(input);
    const previous = commandRef.current;
    if (stream.isPending || (currentMode === 'recovering' && previous?.key !== key)) return;
    const command = previous?.key === key
      ? previous.command
      : current.adapter.createCommand(input, crypto.randomUUID());
    commandRef.current = { key, command };
    stream.mutate(command);
  };

  return {
    state,
    operation: observedOperation ?? null,
    dispatch: dispatchTracked,
    submit,
    pending: stream.isPending || resume.isPending || mode === 'recovering',
    active: mode === 'streaming' || mode === 'selecting' || mode === 'recovering' || mode === 'completed',
    error: mode === 'failed' ? options.adapter.machine.error(state) : null,
  };
}
