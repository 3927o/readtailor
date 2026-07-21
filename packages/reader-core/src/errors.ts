export type ReaderContractErrorCode =
  | 'unsupported_manifest_version'
  | 'invalid_manifest_shape'
  | 'invalid_manifest_semantics'
  | 'unknown_node'
  | 'unknown_block'
  | 'invalid_point'
  | 'invalid_range';

export class ReaderContractError extends Error {
  readonly code: ReaderContractErrorCode;
  readonly path?: string;

  constructor(code: ReaderContractErrorCode, message: string, path?: string) {
    super(message);
    this.name = 'ReaderContractError';
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}
