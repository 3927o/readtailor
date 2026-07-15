import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from './apiError';
import {
  getInterview,
  startInterview,
  streamInterviewAnswer,
  streamResumeInterview,
  type InterviewClientStreamEvent,
  type InterviewQuestion,
} from './api/interview';
import type { StrategySnapshot } from './api/strategy';
import { IDLE_INTERVIEW_STREAM, interviewStreamReducer } from './interviewStreamState';
import { userBookQueryKeys } from './queryKeys';
import { applyTransition } from './transitions';

export interface InterviewChoice {
  optionId?: string;
  text?: string;
}

interface LocalTurn {
  questionId: string;
  question: string;
  answer: string;
}

interface InterviewStreamGeneration {
  generation: number;
}

interface InterviewAnswerRequest extends InterviewStreamGeneration {
  input: { questionId: string; optionId?: string; text?: string };
}

function eventQuestion(event: Extract<InterviewClientStreamEvent, { type: 'question_final' }>): InterviewQuestion {
  return {
    id: event.question.id,
    prompt: event.question.prompt,
    ...(event.question.hint ? { hint: event.question.hint } : {}),
    options: event.question.options,
    ordinal: event.ordinal,
    maxQuestions: event.maxQuestions,
    acknowledgment: event.question.acknowledgment,
    sufficiency: event.question.sufficiency,
  };
}

export function useInterviewController(options: {
  userBookId: string;
  shouldStart: boolean;
}) {
  const queryClient = useQueryClient();
  const [stream, dispatchStream] = useReducer(interviewStreamReducer, IDLE_INTERVIEW_STREAM);
  const [turnSeq, setTurnSeq] = useState(0);
  const [activeQuestion, setActiveQuestion] = useState<InterviewQuestion | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [localHistory, setLocalHistory] = useState<LocalTurn[]>([]);
  const startRequested = useRef(false);
  const resumeRequested = useRef(false);
  const streamGeneration = useRef(0);
  const pendingStrategy = useRef<{ generation: number; strategy: StrategySnapshot } | null>(null);

  const start = useMutation({
    mutationFn: () => startInterview(options.userBookId),
    onSuccess: (snapshot) => {
      void applyTransition(queryClient, options.userBookId, {
        type: 'interview_started',
        interview: snapshot,
      });
    },
  });
  const interview = useQuery({
    queryKey: userBookQueryKeys.interview(options.userBookId),
    queryFn: () => getInterview(options.userBookId),
    enabled: !options.shouldStart,
    refetchInterval: (current) => {
      const snapshot = current.state.data;
      return snapshot?.status === 'active' && !snapshot.currentQuestion ? 1800 : false;
    },
  });

  useEffect(() => {
    if (!options.shouldStart) {
      startRequested.current = false;
      return;
    }
    if (startRequested.current || !start.isIdle) return;
    startRequested.current = true;
    start.mutate();
  }, [options.shouldStart, start]);

  const handleStreamEvent = useCallback((generation: number, event: InterviewClientStreamEvent) => {
    if (generation !== streamGeneration.current) return;
    dispatchStream({ type: 'event', event });
    if (event.type === 'question_final') {
      pendingStrategy.current = null;
      setActiveQuestion(eventQuestion(event));
      void queryClient.invalidateQueries({
        queryKey: userBookQueryKeys.interview(options.userBookId),
      });
    } else if (event.type === 'draft_final') {
      pendingStrategy.current = { generation, strategy: event.strategy };
      queryClient.setQueryData(
        userBookQueryKeys.strategy(options.userBookId, event.strategy.draftId),
        event.strategy,
      );
    } else if (event.type === 'done') {
      const completedStrategy = pendingStrategy.current?.generation === generation
        ? pendingStrategy.current.strategy
        : null;
      pendingStrategy.current = null;
      if (event.workflowStatus === 'strategy_review' && completedStrategy) {
        void applyTransition(queryClient, options.userBookId, {
          type: 'strategy_committed',
          strategy: completedStrategy,
        });
      } else if (event.workflowStatus === 'interviewing') {
        void interview.refetch();
      } else {
        void queryClient.invalidateQueries({
          queryKey: userBookQueryKeys.detail(options.userBookId),
        });
      }
    } else if (event.type === 'error') {
      pendingStrategy.current = null;
      void interview.refetch();
    }
  }, [interview, options.userBookId, queryClient]);

  const resume = useMutation<void, Error, InterviewStreamGeneration>({
    mutationFn: ({ generation }) => streamResumeInterview(options.userBookId, {
      onEvent: (event) => handleStreamEvent(generation, event),
    }),
    onMutate: ({ generation }) => {
      if (generation === streamGeneration.current) dispatchStream({ type: 'recover' });
    },
    onError: (error, { generation }) => {
      if (generation !== streamGeneration.current) return;
      const shouldReconcileWorkflow = pendingStrategy.current?.generation === generation;
      pendingStrategy.current = null;
      const message = error instanceof ApiError ? error.message : '恢复访谈失败，请稍后重试。';
      setStreamError(message);
      dispatchStream({ type: 'transport_error', message });
      if (shouldReconcileWorkflow) {
        void queryClient.invalidateQueries({
          queryKey: userBookQueryKeys.detail(options.userBookId),
        });
      }
    },
  });

  useEffect(() => {
    if (!interview.data?.canResume) {
      resumeRequested.current = false;
      return;
    }
    if (resumeRequested.current || resume.isPending) return;
    resumeRequested.current = true;
    const generation = streamGeneration.current + 1;
    streamGeneration.current = generation;
    pendingStrategy.current = null;
    resume.mutate({ generation });
  }, [interview.data?.canResume, resume]);

  useEffect(() => {
    const snapshot = interview.data;
    if (!snapshot) return;
    dispatchStream({ type: 'reconcile', snapshot });
    if (snapshot.status === 'completed') {
      pendingStrategy.current = null;
      resumeRequested.current = false;
      void queryClient.invalidateQueries({
        queryKey: userBookQueryKeys.detail(options.userBookId),
      });
      return;
    }
    if (snapshot.currentQuestion) {
      setStreamError(null);
      setActiveQuestion((current) => (
        !current || snapshot.currentQuestion!.ordinal >= current.ordinal ? null : current
      ));
    }
    if (snapshot.history.length > 0) {
      const persisted = new Set(snapshot.history.map((turn) => turn.questionId));
      setLocalHistory((history) => history.filter((turn) => !persisted.has(turn.questionId)));
    }
  }, [interview.data, options.userBookId, queryClient]);

  const question = activeQuestion ?? interview.data?.currentQuestion ?? null;
  const answer = useMutation<void, Error, InterviewAnswerRequest>({
    mutationFn: ({ generation, input }) => streamInterviewAnswer(options.userBookId, input, {
      onEvent: (event) => handleStreamEvent(generation, event),
    }),
    onError: (error, { generation }) => {
      if (generation !== streamGeneration.current) return;
      const shouldReconcileWorkflow = pendingStrategy.current?.generation === generation;
      pendingStrategy.current = null;
      const message = error instanceof ApiError ? error.message : '提交失败，请稍后再试。';
      setStreamError(message);
      dispatchStream({ type: 'transport_error', message });
      void interview.refetch();
      if (shouldReconcileWorkflow) {
        void queryClient.invalidateQueries({
          queryKey: userBookQueryKeys.detail(options.userBookId),
        });
      }
    },
  });

  const submit = (choice: InterviewChoice): boolean => {
    if (!question || answer.isPending) return false;
    resume.reset();
    resumeRequested.current = false;
    const answerLabel = choice.optionId
      ? (question.options.find((option) => option.id === choice.optionId)?.label ?? choice.optionId)
      : (choice.text ?? '');
    setLocalHistory((history) => [
      ...history.filter((turn) => turn.questionId !== question.id),
      { questionId: question.id, question: question.prompt, answer: answerLabel },
    ]);
    setStreamError(null);
    setActiveQuestion(null);
    setTurnSeq((value) => value + 1);
    dispatchStream({ type: 'begin', sufficiency: question.sufficiency });
    const generation = streamGeneration.current + 1;
    streamGeneration.current = generation;
    pendingStrategy.current = null;
    answer.mutate({
      generation,
      input: { questionId: question.id, ...choice },
    });
    return true;
  };

  const snapshot = interview.data ?? null;
  const questionStreaming = stream.mode === 'question_streaming';
  const draftView = Boolean(
    snapshot?.status === 'active'
    && (
      stream.mode === 'draft_streaming'
      || (!question && (
        stream.mode === 'recovering'
        || snapshot.turnInProgress
        || snapshot.canResume
      ))
    ),
  );
  const failedView = Boolean(snapshot?.status === 'cancelled' || stream.mode === 'error');
  const interactive = Boolean(
    snapshot
    && stream.mode === 'idle'
    && snapshot.status === 'active'
    && question,
  );
  const history = useMemo(() => {
    if (!snapshot) return [];
    const localByQuestion = new Map(localHistory.map((turn) => [turn.questionId, turn]));
    const covered = new Set<string>();
    const merged = snapshot.history.map((item) => {
      if (item.questionId) covered.add(item.questionId);
      return (item.questionId && localByQuestion.get(item.questionId)) || item;
    });
    for (const turn of localHistory) {
      if (!covered.has(turn.questionId)) merged.push(turn);
    }
    return merged;
  }, [localHistory, snapshot]);

  return {
    shouldStart: options.shouldStart,
    startError: start.error,
    retryStart: () => start.mutate(),
    loading: interview.isPending,
    loadError: interview.error,
    retryLoad: () => void interview.refetch(),
    isFetching: interview.isFetching,
    snapshot,
    completed: snapshot?.status === 'completed',
    stream,
    streamError,
    question,
    turnSeq,
    history,
    draftView,
    failedView,
    interactive,
    answerPending: answer.isPending,
    submit,
    turnAck: questionStreaming ? stream.ack : (question?.acknowledgment ?? ''),
    turnPrompt: questionStreaming ? stream.prompt : (question?.prompt ?? ''),
    turnHint: questionStreaming ? stream.hint : (question?.hint ?? ''),
    turnOptions: questionStreaming ? stream.options : (question?.options ?? []),
    sufficiency: questionStreaming ? stream.sufficiency : (question?.sufficiency ?? null),
    thinking: questionStreaming && !stream.prompt,
  };
}
