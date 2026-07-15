function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonSize(value: unknown): number | null {
  try {
    const json = JSON.stringify(value);
    return typeof json === 'string' ? json.length : null;
  } catch {
    return null;
  }
}

function argumentSummary(value: unknown): Record<string, unknown> {
  return {
    keys: Object.keys(record(value)).sort(),
    size: jsonSize(value),
  };
}

function errorText(value: unknown): string | null {
  const content = record(value).content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((part) => record(part).text)
    .filter((item): item is string => typeof item === 'string')
    .join('\n')
    .trim();
  return text ? text.slice(0, 1000) : null;
}

export function sanitizeAgentTraceEvent(value: unknown): Record<string, unknown> {
  const event = record(value);
  const type = typeof event.type === 'string' ? event.type : 'unknown';
  if (type === 'agent_started') {
    return {
      type,
      agentName: event.agentName ?? null,
      sessionId: event.sessionId ?? null,
      modelName: event.modelName ?? null,
    };
  }
  if (type === 'assistant_message') {
    const message = record(event.message);
    const content = Array.isArray(message.content) ? message.content : [];
    const toolCalls = content
      .map(record)
      .filter((part) => part.type === 'toolCall')
      .map((part) => ({
        toolCallId: typeof part.id === 'string' ? part.id : null,
        toolName: typeof part.name === 'string' ? part.name : null,
        arguments: argumentSummary(part.arguments),
      }));
    return {
      type,
      agentName: event.agentName ?? null,
      turn: event.turn ?? null,
      stopReason: message.stopReason ?? null,
      errorSummary: typeof message.errorMessage === 'string'
        ? message.errorMessage.slice(0, 1000)
        : null,
      usage: record(message.usage),
      toolCalls,
    };
  }
  if (type === 'tool_started') {
    return {
      type,
      agentName: event.agentName ?? null,
      turn: event.turn ?? null,
      toolCallId: event.toolCallId ?? null,
      toolName: event.toolName ?? null,
      arguments: argumentSummary(event.args),
    };
  }
  if (type === 'tool_finished') {
    return {
      type,
      agentName: event.agentName ?? null,
      turn: event.turn ?? null,
      toolCallId: event.toolCallId ?? null,
      toolName: event.toolName ?? null,
      succeeded: event.succeeded === true,
      durationMs: event.durationMs ?? null,
      errorSummary: event.succeeded === true ? null : errorText(event.result),
    };
  }
  const safe: Record<string, unknown> = { type };
  for (const key of ['agentName', 'turn', 'toolResultCount', 'turns', 'toolCalls', 'messageCount']) {
    if (event[key] !== undefined) safe[key] = event[key];
  }
  return safe;
}

export function appendAgentTraceEvent(
  traceEvents: Array<Record<string, unknown>>,
  event: unknown,
): void {
  traceEvents.push({
    sequence: traceEvents.length + 1,
    occurredAt: new Date().toISOString(),
    ...sanitizeAgentTraceEvent(event),
  });
}

export function summarizeAgentTraceEvents(
  traceEvents: Array<Record<string, unknown>>,
): { turnCount: number | null } {
  const finished = [...traceEvents]
    .reverse()
    .find((event) => event.type === 'agent_finished');
  const lastTurn = [...traceEvents]
    .reverse()
    .find((event) => typeof event.turn === 'number');
  return {
    turnCount: typeof finished?.turns === 'number'
      ? finished.turns
      : typeof lastTurn?.turn === 'number'
        ? lastTurn.turn
        : null,
  };
}
