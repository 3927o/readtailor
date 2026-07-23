import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AgentRunJobPayload } from '@readtailor/contracts';

export type AgentRunExecutionOutcome = 'committed' | 'stale';
export type AgentRunFailureOutcome = 'cleared' | 'stale';

export interface AgentRunHandler {
  agentType: AgentRunJobPayload['agentType'];
  execute(input: {
    sessionId: string;
    runId: string;
    input: AgentRunJobPayload['input'];
    emit: (event: AgentEvent) => Promise<void>;
  }): Promise<AgentRunExecutionOutcome>;
  fail(input: {
    sessionId: string;
    runId: string;
    error: Error;
  }): Promise<AgentRunFailureOutcome>;
}

export function createAgentHandlerRegistry(handlers: AgentRunHandler[]) {
  const byType = new Map(handlers.map((handler) => [handler.agentType, handler]));
  if (byType.size !== handlers.length) throw new Error('duplicate Agent handler registration');
  return {
    require(agentType: AgentRunJobPayload['agentType']): AgentRunHandler {
      const handler = byType.get(agentType);
      if (!handler) throw new Error(`Agent handler 未注册: ${agentType}`);
      return handler;
    },
  };
}

export type AgentHandlerRegistry = ReturnType<typeof createAgentHandlerRegistry>;
