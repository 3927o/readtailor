import {
  runAskAiAgent,
  type AskAiOutcome,
  type AskAiToolEvent,
  type AskAiToolbox,
} from '@readtailor/agent-kit';
import {
  appendAgentTraceEvent,
  summarizeAgentTraceEvents,
  timeAgentCall,
  type PerfSink,
} from '@readtailor/observability';

// Per-request seam for the 问 AI turn (mirrors ReadingSetupEngine). The host builds a
// per-request `toolbox` (bound to the user_book, its manifest and reader profile) and passes
// it in with the reconstructed `context`; `onAnswerDelta` streams answer text while all
// side effects remain staged in AskAiOutcome until the host commits the answer.
export interface AskAiEngine {
  runTurn(input: {
    sessionId: string;
    question: string;
    context: Record<string, unknown>;
    toolbox: AskAiToolbox;
    requestId?: string;
    conversationVersion?: number;
    onAnswerDelta?: (chars: string) => void;
    onToolEvent?: (event: AskAiToolEvent) => void;
  }): Promise<AskAiOutcome>;
}

export function createAgentAskAiEngine(options: {
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  perfSink?: PerfSink;
}): AskAiEngine {
  return {
    runTurn(input) {
      const traceEvents: Array<Record<string, unknown>> = [];
      return timeAgentCall(
        options.perfSink,
        {
          requestId: input.requestId ?? null,
          sessionId: input.sessionId,
          conversationVersion: input.conversationVersion ?? null,
          source: 'api',
          kind: 'ask_ai',
          model: options.modelName,
          traceEvents,
        },
        () => runAskAiAgent({
          ...options,
          ...input,
          onTrace: (event) => appendAgentTraceEvent(traceEvents, event),
        }),
        {
          onSuccess: () => summarizeAgentTraceEvents(traceEvents),
          onError: () => summarizeAgentTraceEvents(traceEvents),
        },
      );
    },
  };
}
