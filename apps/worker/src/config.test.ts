import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './config';

describe('loadWorkerConfig', () => {
  it('rejects non-positive concurrency', () => {
    expect(() => loadWorkerConfig({ WORKER_CONCURRENCY: '0' })).toThrow(
      'Environment variable WORKER_CONCURRENCY must be at least 1',
    );
  });

  it('system and normalization concurrency follow WORKER_CONCURRENCY', () => {
    const config = loadWorkerConfig({ WORKER_CONCURRENCY: '4' });
    expect(config.systemConcurrency).toBe(4);
    expect(config.normalizationConcurrency).toBe(4);
  });

  it('content generation concurrency defaults to 5, independent of the base', () => {
    const config = loadWorkerConfig({ WORKER_CONCURRENCY: '1' });
    expect(config.contentGenerationConcurrency).toBe(5);
  });

  it('per-queue concurrency can override the base independently', () => {
    const config = loadWorkerConfig({
      WORKER_CONCURRENCY: '1',
      CONTENT_GENERATION_CONCURRENCY: '3',
    });
    expect(config.contentGenerationConcurrency).toBe(3);
    // The heavy normalization pool stays at the base default when not overridden.
    expect(config.normalizationConcurrency).toBe(1);
    expect(config.systemConcurrency).toBe(1);
  });

  it('enables all queues by default', () => {
    expect(loadWorkerConfig({}).queues).toEqual([
      'system',
      'normalization',
      'content-generation',
    ]);
  });

  it('parses a WORKER_QUEUES subset, trimming and de-duplicating', () => {
    expect(
      loadWorkerConfig({ WORKER_QUEUES: ' content-generation , system , content-generation ' })
        .queues,
    ).toEqual(['content-generation', 'system']);
  });

  it('rejects an unknown WORKER_QUEUES value', () => {
    expect(() => loadWorkerConfig({ WORKER_QUEUES: 'content-generation,bogus' })).toThrow(
      'Environment variable WORKER_QUEUES contains unknown value "bogus"',
    );
  });
});
