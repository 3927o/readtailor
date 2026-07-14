export type GenerationScope = 'trial' | 'formal';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface TextPoint {
  block_index: number;
  offset: number;
}

export interface TextRange {
  start: TextPoint;
  end: TextPoint;
}

export interface GenerationBlock {
  block_index: number;
  text: string;
  html: string;
  source_offset?: number;
}

export interface VersionedProfile {
  version: string;
  value: JsonValue;
}

export interface GenerationProfiles {
  book: VersionedProfile;
  reader: VersionedProfile;
  book_reader: VersionedProfile;
}

export interface NodeSource {
  section_id: string;
  segment: number;
  node_order: number;
  title: string | null;
  ancestor_titles: string[];
  range: TextRange;
  structured_html: string;
  blocks: GenerationBlock[];
  original_notes: JsonValue[];
  previous_context: string | null;
  next_context: string | null;
}

export interface ModelConfiguration {
  model_id: string;
  config_version: string;
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
  user_id: string;
  package_id: string;
  package_version: string;
  profiles: GenerationProfiles;
  source: NodeSource;
  model: ModelConfiguration;
}

export interface TrialGenerationInput extends GenerationInputBase {
  generation_scope: 'trial';
  fragment_range: TextRange;
  strategy: TrialStrategyReference;
}

export interface FormalGenerationInput extends GenerationInputBase {
  generation_scope: 'formal';
  strategy: FormalStrategyReference;
}

export type TailoringGenerationInput = TrialGenerationInput | FormalGenerationInput;

export interface ModelGenerationRequest {
  prompt: string;
  model: ModelConfiguration;
  response_format: 'json';
}

export interface TailoringModelClient {
  generate(request: ModelGenerationRequest): Promise<string>;
}

export interface TailoringAnnotation {
  range: TextRange;
  content: string;
}

export interface TailoringGenerationResult {
  guide: string | null;
  annotations: TailoringAnnotation[];
  after_reading: string | null;
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
