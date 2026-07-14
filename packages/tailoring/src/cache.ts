import { createHash } from 'node:crypto';
import { buildTailoringPrompt, TAILORING_PROMPT_VERSION } from './prompt';
import { stableStringify } from './serialization';
import type { TailoringGenerationInput } from './types';

export function createTailoringCacheKey(input: TailoringGenerationInput): string {
  const prompt = buildTailoringPrompt(input);
  const identity = {
    user_id: input.user_id,
    package: {
      id: input.package_id,
      version: input.package_version,
    },
    profiles: input.profiles,
    strategy: input.strategy,
    scope: {
      generation_scope: input.generation_scope,
      section_id: input.source.section_id,
      segment: input.source.segment,
      range: input.source.range,
    },
    prompt_version: TAILORING_PROMPT_VERSION,
    prompt,
    model: input.model,
  };
  const digest = createHash('sha256').update(stableStringify(identity)).digest('hex');
  return `tailoring:${TAILORING_PROMPT_VERSION}:${digest}`;
}
