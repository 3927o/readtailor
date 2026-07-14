import {
  runAskAiAgent,
  type AskAiOutcome,
  type AskAiToolbox,
  type StrategyChangeProposal,
} from '@readtailor/agent-kit';

// Per-request seam for the 问 AI turn (mirrors ReadingSetupEngine). The host builds a
// per-request `toolbox` (bound to the user_book, its manifest and reader profile) and passes
// it in with the reconstructed `context`; `onAnswerDelta` streams the answer to the SSE
// endpoint and `onProposal` fires when the agent submits a strategy-change proposal.
export interface AskAiEngine {
  runTurn(input: {
    sessionId: string;
    question: string;
    context: Record<string, unknown>;
    toolbox: AskAiToolbox;
    onAnswerDelta?: (chars: string) => void;
    onProposal?: (payload: StrategyChangeProposal) => void | Promise<void>;
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

// Replays a canned answer as synthetic stream deltas so the SSE endpoint (and its tests /
// local dev) exercise the real event + persistence path without a live model. It does not
// touch the toolbox — tool use is the real model's decision — and does not propose a strategy
// change; the proposal path is covered end-to-end by agent-kit's runAskAiAgent tests.
export function createFakeAskAiEngine(): AskAiEngine {
  return {
    async runTurn(input) {
      const answer = `（假模型）针对你的问题「${input.question.trim()}」，这里是一段示例回答。`;
      if (input.onAnswerDelta) {
        for (const char of answer) input.onAnswerDelta(char);
      }
      return {
        answer,
        patchedProfile: false,
        turns: 1,
        toolCalls: 0,
      };
    },
  };
}
