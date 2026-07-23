/** Applies project-level Agent run events to the reconnectable display snapshot. */

import type {
  AgentRunDisplaySnapshot,
  AgentRunEvent,
  AgentRunToolDisplay,
} from '@readtailor/contracts';

function cloneSnapshot(snapshot: AgentRunDisplaySnapshot): AgentRunDisplaySnapshot {
  // Nested message/argument/result DTOs are immutable inputs; only Tool containers are updated.
  return {
    ...snapshot,
    tools: snapshot.tools.map((item) => ({ ...item })),
  };
}

function tool(
  snapshot: AgentRunDisplaySnapshot,
  toolCallId: string,
  toolName = 'unknown',
): AgentRunToolDisplay {
  let item = snapshot.tools.find((candidate) => candidate.toolCallId === toolCallId);
  if (!item) {
    item = {
      toolCallId,
      toolName,
      argumentsBuffer: '',
      arguments: null,
      callFinished: false,
      executionStatus: 'pending',
      result: null,
      isError: false,
    };
    snapshot.tools.push(item);
  } else if (item.toolName === 'unknown' && toolName !== 'unknown') {
    item.toolName = toolName;
  }
  return item;
}

export function reduceAgentRunEvent(
  current: AgentRunDisplaySnapshot | null,
  event: AgentRunEvent,
): AgentRunDisplaySnapshot {
  if (event.type === 'run_snapshot') return cloneSnapshot(event.snapshot);
  if (!current || current.runId !== event.runId) {
    current = {
      runId: event.runId,
      lastSequence: 0,
      status: 'running',
      assistantText: '',
      assistantMessage: null,
      tools: [],
      error: null,
    };
  }
  if (event.sequence <= current.lastSequence) return current;

  const next = cloneSnapshot(current);
  next.lastSequence = event.sequence;
  switch (event.type) {
    case 'assistant_text_delta':
      next.assistantText += event.delta;
      break;
    case 'tool_call_started':
      tool(next, event.toolCallId, event.toolName);
      break;
    case 'tool_call_arguments_delta':
      tool(next, event.toolCallId).argumentsBuffer += event.delta;
      break;
    case 'tool_call_finished': {
      const item = tool(next, event.toolCallId, event.toolName);
      item.arguments = event.arguments;
      item.callFinished = true;
      break;
    }
    case 'assistant_message_finished':
      next.assistantMessage = event.message;
      break;
    case 'tool_execution_started':
      tool(next, event.toolCallId, event.toolName).executionStatus = 'running';
      break;
    case 'tool_execution_progress':
      break;
    case 'tool_execution_finished': {
      const item = tool(next, event.toolCallId);
      item.executionStatus = 'completed';
      item.result = event.result;
      item.isError = event.isError;
      break;
    }
    case 'run_finished':
      next.status = event.status;
      next.error = event.error ?? null;
      break;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
  return next;
}
