/** Maps one persisted or live Agent Tool fact into a backend-neutral transcript entry. */

import type {
  AgentRunToolDisplay,
  AgentSessionState,
} from '@readtailor/contracts';
import { parsePartialJson } from '../../agent-driven-reading-setup/partial-json';
import type {
  QuestionAnswerView,
  ReadingSetupActionState,
  ReadingSetupRenderState,
  ReadingSetupTranscriptEntry,
  TrialAnnotationView,
  TrialParagraphView,
} from './types';

const QUERY_TOOL_ACTIVITY: Record<string, string> = {
  get_reader_profile: '正在了解你的长期阅读偏好',
  get_book_profile: '正在读取这本书的基本画像',
  get_book_outline: '正在浏览这本书的结构',
  list_reading_nodes: '正在寻找适合阅读的段落',
  read_book_node: '正在核对原文',
  search_book: '正在书中查找相关内容',
};

// Partial Tool arguments are intentionally read field-by-field while JSON is streaming.
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function optionalString<K extends string>(
  key: K,
  value: unknown,
): { [P in K]?: string } {
  return typeof value === 'string' ? { [key]: value } as { [P in K]?: string } : {};
}

function optionalBoolean<K extends string>(
  key: K,
  value: unknown,
): { [P in K]?: boolean } {
  return typeof value === 'boolean'
    ? { [key]: value } as { [P in K]?: boolean }
    : {};
}

export function unwrapToolResult(value: unknown): unknown {
  return record(value)?.details ?? value;
}

function questionEntry(input: ToolProjectionInput): ReadingSetupTranscriptEntry {
  const args = record(input.argumentsValue);
  const options = Array.isArray(args?.options)
    ? args.options.flatMap((value) => {
        const option = record(value);
        return typeof option?.id === 'string' && typeof option.label === 'string'
          ? [{ id: option.id, label: option.label }]
          : [];
      })
    : [];
  return {
    id: input.id,
    kind: 'question',
    toolCallId: input.toolCallId,
    renderState: input.renderState,
    ...optionalString('prompt', args?.prompt),
    ...optionalString('hint', args?.hint),
    options,
    ...optionalBoolean('allowFreeText', args?.allowFreeText),
    ...(input.answer ? { answer: input.answer } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

function briefEntry(input: ToolProjectionInput): ReadingSetupTranscriptEntry {
  const brief = record(record(input.argumentsValue)?.brief);
  return {
    id: input.id,
    kind: 'brief',
    toolCallId: input.toolCallId,
    renderState: input.renderState,
    brief: {
      ...optionalString('bookIdentity', brief?.bookIdentity),
      ...optionalString('arc', brief?.arc),
      ...optionalString('assumedKnowledge', brief?.assumedKnowledge),
      ...optionalString('readingAdvice', brief?.readingAdvice),
    },
    ...(input.error ? { error: input.error } : {}),
  };
}

function strategyEntry(input: ToolProjectionInput): ReadingSetupTranscriptEntry {
  const args = record(input.argumentsValue);
  const strategy = record(args?.strategy);
  const guide = record(strategy?.guide);
  const annotations = record(strategy?.annotations);
  const afterReading = record(strategy?.afterReading);
  return {
    id: input.id,
    kind: 'strategy',
    toolCallId: input.toolCallId,
    renderState: input.renderState,
    ...optionalString('summary', args?.summary),
    strategy: {
      ...(Array.isArray(strategy?.goals) ? { goals: strings(strategy.goals) } : {}),
      ...(Array.isArray(strategy?.expressionPrinciples)
        ? { expressionPrinciples: strings(strategy.expressionPrinciples) }
        : {}),
      ...(guide ? {
        guide: {
          ...optionalBoolean('enabled', guide.enabled),
          ...(Array.isArray(guide.objectives)
            ? { objectives: strings(guide.objectives) }
            : {}),
        },
      } : {}),
      ...(annotations ? {
        annotations: {
          ...optionalBoolean('enabled', annotations.enabled),
          ...(Array.isArray(annotations.focuses)
            ? { focuses: strings(annotations.focuses) }
            : {}),
          ...(Array.isArray(annotations.exclusions)
            ? { exclusions: strings(annotations.exclusions) }
            : {}),
        },
      } : {}),
      ...(afterReading ? {
        afterReading: {
          ...optionalBoolean('enabled', afterReading.enabled),
          ...(Array.isArray(afterReading.objectives)
            ? { objectives: strings(afterReading.objectives) }
            : {}),
        },
      } : {}),
    },
    confirmation: input.confirmation,
    ...(input.error ? { error: input.error } : {}),
  };
}

interface TrialBlock {
  blockIndex: number;
  text: string;
  sourceOffset: number;
}

// Trial annotations use canonical offsets; sourceOffset translates them into sliced text.
interface TrialAnnotation {
  id: string;
  blockIndex: number;
  start: number;
  end: number;
  content: string;
}

function trialContent(resultValue: unknown, toolCallId: string): {
  titlePath: string[];
  paragraphs: TrialParagraphView[];
  annotations: TrialAnnotationView[];
  guide?: string;
  afterReading?: string;
} {
  const result = record(unwrapToolResult(resultValue));
  const source = record(result?.source);
  const blocks: TrialBlock[] = Array.isArray(source?.blocks)
    ? source.blocks.flatMap((value) => {
        const block = record(value);
        return Number.isInteger(block?.blockIndex) && typeof block?.text === 'string'
          ? [{
              blockIndex: block.blockIndex as number,
              text: block.text,
              sourceOffset: Number.isInteger(block.sourceOffset)
                ? block.sourceOffset as number
                : 0,
            }]
          : [];
      })
    : [];
  const annotations: TrialAnnotation[] = Array.isArray(result?.annotations)
    ? result.annotations.flatMap((value, index) => {
        const annotation = record(value);
        const range = record(annotation?.range);
        const start = record(range?.start);
        const end = record(range?.end);
        const startBlockIndex = start?.blockIndex;
        const endBlockIndex = end?.blockIndex;
        const startOffset = start?.offset;
        const endOffset = end?.offset;
        return (
          Number.isInteger(startBlockIndex)
          && startBlockIndex === endBlockIndex
          && Number.isInteger(startOffset)
          && Number.isInteger(endOffset)
          && typeof annotation?.content === 'string'
        )
          ? [{
              id: `${toolCallId}-annotation-${index}`,
              blockIndex: startBlockIndex as number,
              start: startOffset as number,
              end: endOffset as number,
              content: annotation.content,
            }]
          : [];
      })
    : [];

  const annotationViews: TrialAnnotationView[] = [];
  const paragraphs = blocks.map((block): TrialParagraphView => {
    const anchored = annotations
      .filter((annotation) => annotation.blockIndex === block.blockIndex)
      .sort((left, right) => left.start - right.start);
    const segments: TrialParagraphView['segments'] = [];
    let cursor = 0;
    for (const annotation of anchored) {
      const start = annotation.start - block.sourceOffset;
      const end = annotation.end - block.sourceOffset;
      if (start > cursor) segments.push({ text: block.text.slice(cursor, start) });
      const text = block.text.slice(start, end);
      segments.push({ text, annotationId: annotation.id });
      annotationViews.push({
        id: annotation.id,
        label: text,
        content: annotation.content,
      });
      cursor = end;
    }
    if (cursor < block.text.length) segments.push({ text: block.text.slice(cursor) });
    return {
      id: `${toolCallId}-block-${block.blockIndex}`,
      segments,
    };
  });

  return {
    titlePath: strings(source?.titlePath),
    paragraphs,
    annotations: annotationViews,
    ...optionalString('guide', result?.guide),
    ...optionalString('afterReading', result?.afterReading),
  };
}

function trialEntry(input: ToolProjectionInput): ReadingSetupTranscriptEntry {
  const args = record(input.argumentsValue);
  return {
    id: input.id,
    kind: 'trial',
    toolCallId: input.toolCallId,
    renderState: input.renderState,
    ...optionalString('reason', args?.reason),
    ...trialContent(input.resultValue, input.toolCallId),
    confirmation: input.confirmation,
    ...(input.error ? { error: input.error } : {}),
  };
}

export interface ToolProjectionInput {
  id: string;
  toolCallId: string;
  toolName: string;
  argumentsValue: unknown;
  resultValue: unknown;
  renderState: ReadingSetupRenderState;
  confirmation: ReadingSetupActionState;
  answer?: QuestionAnswerView;
  error?: string;
}

// Known Tool names select product renderers; unknown names retain a usable generic status.
export function projectToolEntry(
  input: ToolProjectionInput,
): ReadingSetupTranscriptEntry | null {
  if (input.toolName in QUERY_TOOL_ACTIVITY) {
    if (input.renderState === 'ready') return null;
    return {
      id: input.id,
      kind: 'query',
      toolCallId: input.toolCallId,
      renderState: input.renderState,
      activity: QUERY_TOOL_ACTIVITY[input.toolName]!,
      ...(input.error ? { error: input.error } : {}),
    };
  }
  switch (input.toolName) {
    case 'present_question':
      return questionEntry(input);
    case 'publish_brief':
      return briefEntry(input);
    case 'publish_book_reader_profile':
      return {
        id: input.id,
        kind: 'profile',
        toolCallId: input.toolCallId,
        renderState: input.renderState,
      };
    case 'publish_strategy':
      return strategyEntry(input);
    case 'generate_trial_slice':
      return trialEntry(input);
    case 'complete_reading_setup':
      if (input.renderState === 'working') {
        return {
          id: input.id,
          kind: 'notice',
          tone: 'quiet',
          message: '正在把这份读前准备放进正式阅读…',
        };
      }
      if (input.renderState === 'failed') {
        return {
          id: input.id,
          kind: 'notice',
          tone: 'error',
          message: input.error ?? '完成阅读准备时遇到了问题。',
        };
      }
      return null;
    default:
      return {
        id: input.id,
        kind: 'tool',
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        renderState: input.renderState,
        ...(input.error ? { error: input.error } : {}),
      };
  }
}

export function liveToolArguments(tool: AgentRunToolDisplay): unknown {
  return tool.arguments ?? parsePartialJson(tool.argumentsBuffer);
}

export function confirmationTargets(
  state: AgentSessionState,
): ReadonlySet<string> {
  return new Set(
    state.actions.flatMap((action) =>
      action.type === 'confirmation' ? [action.targetToolCallId] : []),
  );
}
