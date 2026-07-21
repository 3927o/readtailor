import type { BlockRange, CanonicalReadingBlock } from '@readtailor/reader-core';

export type GenerationScope = 'trial' | 'formal';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface GenerationBlock extends CanonicalReadingBlock {
  html: string;
  sourceOffset?: number;
}

export interface VersionedProfile {
  version: string;
  value: JsonValue;
}

export interface GenerationProfiles {
  book: VersionedProfile;
  reader: VersionedProfile;
  bookReader: VersionedProfile;
}

export interface NodeSource {
  sectionId: string;
  segment: number;
  nodeOrder: number;
  title: string | null;
  ancestorTitles: string[];
  range: BlockRange;
  structuredHtml: string;
  blocks: GenerationBlock[];
  originalNotes: JsonValue[];
  previousContext: string | null;
  nextContext: string | null;
}

export interface ModelConfiguration {
  modelId: string;
  configVersion: string;
}

export interface TrialStrategyReference {
  kind: 'strategy_draft';
  version: string;
  status: 'approved_for_trial';
  value: JsonValue;
}

export interface FormalStrategyReference {
  kind: 'strategy';
  version: string;
  status: 'active';
  value: JsonValue;
}

interface GenerationInputBase {
  userId: string;
  packageId: string;
  packageVersion: string;
  profiles: GenerationProfiles;
  source: NodeSource;
  model: ModelConfiguration;
}

export interface TrialGenerationInput extends GenerationInputBase {
  generationScope: 'trial';
  fragmentRange: BlockRange;
  strategy: TrialStrategyReference;
}

export interface FormalGenerationInput extends GenerationInputBase {
  generationScope: 'formal';
  strategy: FormalStrategyReference;
}

export type TailoringGenerationInput = TrialGenerationInput | FormalGenerationInput;

export interface ModelGenerationRequest {
  prompt: string;
  model: ModelConfiguration;
  responseFormat: 'json';
}

export interface TailoringModelClient {
  generate(request: ModelGenerationRequest): Promise<string>;
}

export interface TailoringAnnotation {
  range: BlockRange;
  content: string;
}

export interface TailoringGenerationResult {
  guide: string | null;
  annotations: TailoringAnnotation[];
  afterReading: string | null;
}

export type TailoringErrorCode =
  | 'invalid_input'
  | 'invalid_scope'
  | 'invalid_strategy_reference'
  | 'invalid_model_json'
  | 'invalid_model_output'
  | 'invalid_anchor'
  | 'empty_trial_result';

export class TailoringError extends Error {
  readonly code: TailoringErrorCode;

  constructor(code: TailoringErrorCode, message: string) {
    super(message);
    this.name = 'TailoringError';
    this.code = code;
  }
}
