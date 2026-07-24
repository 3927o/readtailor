/** Models transport connection changes without introducing reading-setup workflow state. */

export type ReadingSetupConnection =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected';

export type ReadingSetupConnectionEvent =
  | { type: 'connecting' }
  | { type: 'connected' }
  | { type: 'interrupted'; retrying: boolean }
  | { type: 'closed' };

export function reduceReadingSetupConnection(
  _current: ReadingSetupConnection,
  event: ReadingSetupConnectionEvent,
): ReadingSetupConnection {
  switch (event.type) {
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'interrupted':
      return event.retrying ? 'reconnecting' : 'disconnected';
    case 'closed':
      return 'disconnected';
  }
}
