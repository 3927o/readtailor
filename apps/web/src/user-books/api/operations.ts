import type {
  CurrentReadingSetupOperationResponse,
  ReadingSetupOperationResponse,
} from '@readtailor/contracts';
import { getJson, postJson, userBookRoot } from './http';

export function getCurrentReadingSetupOperation(
  userBookId: string,
): Promise<CurrentReadingSetupOperationResponse> {
  return getJson(`${userBookRoot(userBookId)}/reading-setup-operation/current`);
}

export function getReadingSetupOperation(
  userBookId: string,
  operationId: string,
): Promise<ReadingSetupOperationResponse> {
  return getJson(`${userBookRoot(userBookId)}/reading-setup-operation/${encodeURIComponent(operationId)}`);
}

export function resumeReadingSetupOperation(
  userBookId: string,
  operationId: string,
): Promise<ReadingSetupOperationResponse> {
  return postJson(`${userBookRoot(userBookId)}/reading-setup-operation/${encodeURIComponent(operationId)}/resume`);
}
