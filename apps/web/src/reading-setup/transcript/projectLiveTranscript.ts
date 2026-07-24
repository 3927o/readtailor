/** Preserves subscribed event order while projecting the reconnectable active Run snapshot. */

import type {
  AgentRunDisplaySnapshot,
  AgentRunEvent,
} from '@readtailor/contracts';
import {
  liveToolArguments,
  projectToolEntry,
} from './projectToolEntry';
import type {
  ReadingSetupRenderState,
  ReadingSetupTranscriptEntry,
} from './types';

type LiveRunOrderItem =
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'tool'; toolCallId: string };

export interface LiveRunOrder {
  runId: string;
  lastSequence: number;
  items: LiveRunOrderItem[];
}

export function createLiveRunOrder(
  snapshot: AgentRunDisplaySnapshot | null,
): LiveRunOrder | null {
  if (!snapshot) return null;
  return {
    runId: snapshot.runId,
    lastSequence: snapshot.lastSequence,
    items: [
      ...(snapshot.assistantText
        ? [{
            kind: 'assistant' as const,
            id: `snapshot-${snapshot.lastSequence}`,
            text: snapshot.assistantText,
          }]
        : []),
      ...snapshot.tools.map((tool) => ({
        kind: 'tool' as const,
        toolCallId: tool.toolCallId,
      })),
    ],
  };
}

function eventToolCallId(event: AgentRunEvent): string | null {
  switch (event.type) {
    case 'tool_call_started':
    case 'tool_call_arguments_delta':
    case 'tool_call_finished':
    case 'tool_execution_started':
    case 'tool_execution_progress':
    case 'tool_execution_finished':
      return event.toolCallId;
    default:
      return null;
  }
}

export function reduceLiveRunOrder(
  current: LiveRunOrder | null,
  event: AgentRunEvent,
): LiveRunOrder {
  if (event.type === 'run_snapshot') return createLiveRunOrder(event.snapshot)!;
  const base = current?.runId === event.runId
    ? current
    : { runId: event.runId, lastSequence: 0, items: [] };
  if (event.sequence <= base.lastSequence) return base;
  const items = base.items.map((item) => ({ ...item }));

  if (event.type === 'assistant_text_delta') {
    const last = items.at(-1);
    if (last?.kind === 'assistant') last.text += event.delta;
    else {
      items.push({
        kind: 'assistant',
        id: `sequence-${event.sequence}`,
        text: event.delta,
      });
    }
  } else {
    const toolCallId = eventToolCallId(event);
    if (
      toolCallId
      && !items.some((item) => item.kind === 'tool' && item.toolCallId === toolCallId)
    ) {
      items.push({ kind: 'tool', toolCallId });
    }
  }
  return { runId: event.runId, lastSequence: event.sequence, items };
}

function renderState(
  tool: AgentRunDisplaySnapshot['tools'][number],
): ReadingSetupRenderState {
  if (tool.executionStatus === 'completed') return tool.isError ? 'failed' : 'ready';
  if (tool.executionStatus === 'running') return 'working';
  return 'streaming';
}

export function projectLiveReadingSetupTranscript(
  snapshot: AgentRunDisplaySnapshot | null,
  eventOrder: LiveRunOrder | null = createLiveRunOrder(snapshot),
): ReadingSetupTranscriptEntry[] {
  if (!snapshot) return [];
  const order = eventOrder?.runId === snapshot.runId
    ? eventOrder
    : createLiveRunOrder(snapshot)!;
  const entries: ReadingSetupTranscriptEntry[] = [];
  order.items.forEach((item, itemIndex) => {
    if (item.kind === 'assistant') {
      entries.push({
        id: `live-run-${snapshot.runId}-assistant-${item.id}`,
        kind: 'assistant',
        text: item.text,
        streaming: (
          (snapshot.status === 'queued' || snapshot.status === 'running')
          && itemIndex === order.items.length - 1
        ),
      });
      return;
    }
    const tool = snapshot.tools.find(
      (candidate) => candidate.toolCallId === item.toolCallId,
    );
    if (!tool) return;
    const entry = projectToolEntry({
      id: `live-run-${snapshot.runId}-tool-${tool.toolCallId}`,
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      argumentsValue: liveToolArguments(tool),
      resultValue: tool.result,
      renderState: renderState(tool),
      confirmation: 'available',
      ...(tool.isError ? { error: '这一步没有成功完成。' } : {}),
    });
    if (entry) entries.push(entry);
  });
  if (
    snapshot.status === 'queued'
    && !snapshot.assistantText
    && snapshot.tools.length === 0
  ) {
    entries.push({
      id: `live-run-${snapshot.runId}-queued`,
      kind: 'notice',
      tone: 'quiet',
      message: '我已经收到，马上继续准备。',
    });
  }
  return entries;
}
