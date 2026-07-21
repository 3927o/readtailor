export { createTailoringCacheKey } from './cache';
export { parseTailoringModelResponse } from './parser';
export { buildTailoringPrompt, TAILORING_PROMPT_VERSION } from './prompt';
export {
  TailoringError,
  type FormalGenerationInput,
  type FormalStrategyReference,
  type GenerationBlock,
  type GenerationProfiles,
  type GenerationScope,
  type JsonPrimitive,
  type JsonValue,
  type ModelConfiguration,
  type ModelGenerationRequest,
  type NodeSource,
  type TailoringAnnotation,
  type TailoringErrorCode,
  type TailoringGenerationInput,
  type TailoringGenerationResult,
  type TailoringModelClient,
  type TrialGenerationInput,
  type TrialStrategyReference,
  type VersionedProfile,
} from './types';
export type { BlockPoint, BlockRange, CanonicalReadingBlock } from '@readtailor/reader-core';
export { validateGenerationInput } from './validation';
export {
  extractBlocks,
  extractNodeSourceFromHtml,
  extractNodeTexts,
  sliceNodeSource,
  type ExtractedNodeSource,
} from './source';

import { parseTailoringModelResponse } from './parser';
import { buildTailoringPrompt } from './prompt';
import type {
  TailoringGenerationInput,
  TailoringGenerationResult,
  TailoringModelClient,
} from './types';

export async function generateTailoredContent(
  input: TailoringGenerationInput,
  modelClient: TailoringModelClient,
): Promise<TailoringGenerationResult> {
  const prompt = buildTailoringPrompt(input);
  const response = await modelClient.generate({
    prompt,
    model: input.model,
    responseFormat: 'json',
  });
  return parseTailoringModelResponse(response, input);
}
