import type {
  NormalizationAgentToolbox,
  NormalizationFinishBinding,
} from '@readtailor/agent-kit';

export type NormalizationArtifact = {
  kind:
    | 'normalizer_script'
    | 'normalizer_stdout'
    | 'normalizer_stderr'
    | 'linter_report'
    | 'validation_report'
    | 'candidate_inventory';
  revision: number;
  bytes: Uint8Array;
  metadata?: Record<string, unknown>;
};

export interface NormalizationSandboxSession extends NormalizationAgentToolbox {
  readonly id: string;
  readonly provider: string;
  downloadOutput(destination: string): Promise<void>;
  readNormalizer(): Promise<Uint8Array>;
  getFinishBinding(): NormalizationFinishBinding | undefined;
  close(): Promise<void>;
}

export type NormalizationArtifactSink = (
  artifact: NormalizationArtifact,
) => void | Promise<void>;
