/** Builds provider model descriptors used by Agent handlers at runtime. */

import type { Model } from '@earendil-works/pi-ai';

export function createOpenAiCompatibleAgentModel(options: {
  apiBaseUrl: string;
  modelName: string;
}): Model<'openai-completions'> {
  return {
    id: options.modelName,
    name: options.modelName,
    api: 'openai-completions',
    provider: 'readtailor-openai-compatible',
    baseUrl: options.apiBaseUrl.replace(/\/+$/, ''),
    reasoning: true,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}
