/** Shares bounded result formatting, schema adaptation, and transcript lookup across tools. */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type TSchema } from '@earendil-works/pi-ai';
import {
  indexAgentTranscript,
  type SuccessfulAgentToolCall,
} from '@readtailor/agent-state';
import {
  AGENT_READ_RESULT_MAX_BYTES,
  type AgentJsonValue,
  type AgentMessageDto,
} from '@readtailor/contracts';
import type {
  ReadingManifest,
  ReadingManifestNode,
} from '@readtailor/reader-core';
import { toAgentJsonValue } from '@readtailor/agent-kit/runtime';

export function defineTool<TParameters extends TSchema>(
  definition: AgentTool<TParameters>,
): AgentTool<TParameters> {
  return definition;
}

export function compatibleSchema<T>(schema: unknown) {
  return Type.Unsafe<T>(schema as TSchema);
}

export function asObject(value: AgentJsonValue): Record<string, AgentJsonValue> {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('Tool arguments 必须是 object');
  }
  return value;
}

export function resultText(text: string, details: unknown) {
  const result = toAgentJsonValue(details);
  return {
    content: [{ type: 'text' as const, text: `${text}\n${JSON.stringify(result)}` }],
    details: result,
  };
}

export function boundedDetails<T>(value: T, label: string): T {
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (size > AGENT_READ_RESULT_MAX_BYTES) {
    throw new Error(`${label} 超过 ${AGENT_READ_RESULT_MAX_BYTES} bytes 响应上限，请缩小分页参数`);
  }
  return value;
}

export function clamp(value: number | undefined, fallback: number, maximum: number): number {
  return Math.max(1, Math.min(value ?? fallback, maximum));
}

export function titlePath(node: ReadingManifestNode, manifest: ReadingManifest): string[] {
  const bySection = new Map(manifest.outline.map((item) => [item.sectionId, item]));
  const output: string[] = [];
  let current = bySection.get(node.sectionId);
  if (!current && node.parentSectionId) current = bySection.get(node.parentSectionId);
  while (current) {
    if (current.title.trim()) output.unshift(current.title.trim());
    current = current.parentSectionId ? bySection.get(current.parentSectionId) : undefined;
  }
  if (node.title.trim() && output.at(-1) !== node.title.trim()) output.push(node.title.trim());
  return output;
}

export interface ReadingSetupToolHistory {
  requireSuccessful(toolCallId: string, toolName: string): SuccessfulAgentToolCall;
  latestSuccessful(toolName: string): SuccessfulAgentToolCall | undefined;
}

export function createReadingSetupToolHistory(
  messages: () => readonly AgentMessageDto[],
): ReadingSetupToolHistory {
  return {
    requireSuccessful(toolCallId, toolName) {
      const record = indexAgentTranscript(messages()).getSuccessful(toolCallId, toolName);
      if (!record) {
        throw new Error(`${toolCallId} 不是当前 session 中成功的 ${toolName} 调用`);
      }
      return record;
    },
    latestSuccessful(toolName) {
      return indexAgentTranscript(messages()).latestSuccessful(toolName);
    },
  };
}
