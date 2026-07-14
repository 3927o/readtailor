import {
  runAskAiAgent,
  type AskAiOutcome,
  type AskAiToolbox,
} from '@readtailor/agent-kit';

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
    onAnswerDelta?: (chars: string) => void;
  }): Promise<AskAiOutcome>;
}

export function createAgentAskAiEngine(options: {
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
}): AskAiEngine {
  return {
    runTurn(input) {
      return runAskAiAgent({ ...options, ...input });
    },
  };
}
