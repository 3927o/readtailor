import {
  TailoringError,
  type GenerationBlock,
  type TailoringAnnotation,
  type TailoringGenerationInput,
  type TailoringGenerationResult,
} from './types';
import { rangeContains, validateGenerationInput } from './validation';

interface RawAnnotation {
  block_index: number;
  quote: string;
  content: string;
}

interface RawOutput {
  guide: string | null;
  annotations: RawAnnotation[];
  after_reading: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function parseNullableMarkdown(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TailoringError('invalid_model_output', `${field} must be null or a non-empty string`);
  }
  return value;
}

function unwrapJsonFence(response: string): string {
  const trimmed = response.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ?? trimmed;
}

function parseRawOutput(response: string): RawOutput {
  let value: unknown;
  try {
    value = JSON.parse(unwrapJsonFence(response));
  } catch {
    throw new TailoringError('invalid_model_json', 'model response is not valid JSON');
  }

  if (!isRecord(value) || !hasExactKeys(value, ['guide', 'annotations', 'after_reading'])) {
    throw new TailoringError(
      'invalid_model_output',
      'model output must contain exactly guide, annotations, and after_reading',
    );
  }
  if (!Array.isArray(value.annotations)) {
    throw new TailoringError('invalid_model_output', 'annotations must be an array');
  }

  const annotations = value.annotations.map((annotation, index): RawAnnotation => {
    if (!isRecord(annotation) || !hasExactKeys(annotation, ['block_index', 'quote', 'content'])) {
      throw new TailoringError(
        'invalid_model_output',
        `annotations[${index}] must contain exactly block_index, quote, and content`,
      );
    }
    if (!Number.isInteger(annotation.block_index) || (annotation.block_index as number) < 1) {
      throw new TailoringError(
        'invalid_model_output',
        `annotations[${index}].block_index must be a positive integer`,
      );
    }
    if (typeof annotation.quote !== 'string' || annotation.quote.length === 0) {
      throw new TailoringError(
        'invalid_model_output',
        `annotations[${index}].quote must be a non-empty string`,
      );
    }
    if (typeof annotation.content !== 'string' || annotation.content.trim().length === 0) {
      throw new TailoringError(
        'invalid_model_output',
        `annotations[${index}].content must be a non-empty string`,
      );
    }
    return {
      block_index: annotation.block_index as number,
      quote: annotation.quote,
      content: annotation.content,
    };
  });

  return {
    guide: parseNullableMarkdown(value.guide, 'guide'),
    annotations,
    after_reading: parseNullableMarkdown(value.after_reading, 'after_reading'),
  };
}

function resolveAnnotation(
  annotation: RawAnnotation,
  blocksByIndex: ReadonlyMap<number, GenerationBlock>,
  input: TailoringGenerationInput,
  index: number,
): TailoringAnnotation {
  const block = blocksByIndex.get(annotation.block_index);
  if (!block) {
    throw new TailoringError(
      'invalid_anchor',
      `annotations[${index}] references block ${annotation.block_index} outside the source`,
    );
  }

  const start = block.text.indexOf(annotation.quote);
  if (start < 0) {
    throw new TailoringError(
      'invalid_anchor',
      `annotations[${index}].quote does not exactly match block ${annotation.block_index}`,
    );
  }
  if (block.text.indexOf(annotation.quote, start + 1) >= 0) {
    throw new TailoringError(
      'invalid_anchor',
      `annotations[${index}].quote is not unique in block ${annotation.block_index}`,
    );
  }

  const sourceOffset = block.source_offset ?? 0;
  const range = {
    start: { block_index: annotation.block_index, offset: sourceOffset + start },
    end: {
      block_index: annotation.block_index,
      offset: sourceOffset + start + annotation.quote.length,
    },
  };
  if (!rangeContains(input.source.range, range)) {
    throw new TailoringError(
      'invalid_anchor',
      `annotations[${index}].quote falls outside the generation range`,
    );
  }

  return { range, content: annotation.content };
}

export function parseTailoringModelResponse(
  response: string,
  input: TailoringGenerationInput,
): TailoringGenerationResult {
  const blocksByIndex = validateGenerationInput(input);
  const raw = parseRawOutput(response);
  const result = {
    guide: raw.guide,
    annotations: raw.annotations.map((annotation, index) =>
      resolveAnnotation(annotation, blocksByIndex, input, index),
    ),
    after_reading: raw.after_reading,
  };

  if (
    input.generation_scope === 'trial' &&
    result.guide === null &&
    result.annotations.length === 0 &&
    result.after_reading === null
  ) {
    throw new TailoringError(
      'empty_trial_result',
      'trial generation must produce at least one visible enhancement',
    );
  }
  return result;
}
