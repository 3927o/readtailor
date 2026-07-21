import { createHash } from 'node:crypto';
import { buildTailoringPrompt, TAILORING_PROMPT_VERSION } from './prompt';
import { stableStringify } from './serialization';
import type { TailoringGenerationInput } from './types';

export function createTailoringCacheKey(input: TailoringGenerationInput): string {
  const prompt = buildTailoringPrompt(input);
  const identity = {
    userId: input.userId,
    package: {
      id: input.packageId,
      version: input.packageVersion,
    },
    profiles: input.profiles,
    strategy: input.strategy,
    scope: {
      generationScope: input.generationScope,
      sectionId: input.source.sectionId,
      segment: input.source.segment,
      range: input.source.range,
    },
    promptVersion: TAILORING_PROMPT_VERSION,
    prompt,
    model: input.model,
  };
  const digest = createHash('sha256').update(stableStringify(identity)).digest('hex');
  return `tailoring:${TAILORING_PROMPT_VERSION}:${digest}`;
}
