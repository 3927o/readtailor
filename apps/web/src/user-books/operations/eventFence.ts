export interface ReadingSetupStreamEnvelope {
  operationId: string;
  operationAttempt: number;
  sequence: number;
  speculativeEpoch?: number;
}

export interface ReadingSetupEventFence {
  operationId: string | null;
  operationAttempt: number;
  sequence: number;
  speculativeEpoch: number;
}

export const EMPTY_READING_SETUP_EVENT_FENCE: ReadingSetupEventFence = {
  operationId: null,
  operationAttempt: 0,
  sequence: 0,
  speculativeEpoch: 0,
};

export function advanceReadingSetupEventFence(
  current: ReadingSetupEventFence,
  event: ReadingSetupStreamEnvelope,
): ReadingSetupEventFence | null {
  if (current.operationId && current.operationId !== event.operationId) return null;
  if (event.operationAttempt < current.operationAttempt) return null;

  const newerAttempt = event.operationAttempt > current.operationAttempt;
  const sequence = newerAttempt ? 0 : current.sequence;
  const speculativeEpoch = newerAttempt ? 0 : current.speculativeEpoch;
  if (event.sequence <= sequence) return null;
  if (event.speculativeEpoch !== undefined && event.speculativeEpoch < speculativeEpoch) return null;

  return {
    operationId: current.operationId ?? event.operationId,
    operationAttempt: event.operationAttempt,
    sequence: event.sequence,
    speculativeEpoch: event.speculativeEpoch ?? speculativeEpoch,
  };
}
