import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config';

describe('loadWorkerConfig', () => {
  it('rejects non-positive concurrency', () => {
    expect(() => loadWorkerConfig({ WORKER_CONCURRENCY: '0' })).toThrow(
      'Environment variable WORKER_CONCURRENCY must be at least 1',
    );
  });
});
