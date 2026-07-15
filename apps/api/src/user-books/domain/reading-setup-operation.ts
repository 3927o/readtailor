import { createHash } from 'node:crypto';
import type {
  ReadingSetupOperationPayload,
  ReadingSetupOperationSource,
} from '@readtailor/contracts';

export type ReadingSetupOperationHashInput = {
  source: ReadingSetupOperationSource;
  baseStrategyDraftVersionId: string;
  baseTrialRevisionId: string | null;
  payload: ReadingSetupOperationPayload;
};

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJsonValue(item)]),
    );
  }
  return value;
}

export function readingSetupOperationRequestHash(
  command: ReadingSetupOperationHashInput,
): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue(command)))
    .digest('hex');
}
