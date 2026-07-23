import { describe, expect, it } from 'vitest';
import { allEnabledQueuesActive, loadWorkerConfig } from './config';

describe('loadWorkerConfig', () => {
  it('requires every enabled queue consumer to be active for readiness', () => {
    expect(
      allEnabledQueuesActive(['system', 'normalization'], {
        system: true,
        normalization: false,
        'content-generation': true,
        'agent-run': true,
      }),
    ).toBe(false);
    expect(
      allEnabledQueuesActive(['system'], {
        system: true,
        normalization: false,
        'content-generation': false,
        'agent-run': false,
      }),
    ).toBe(true);
  });

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
      'agent-run',
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

  it('uses E2B as the default normalization sandbox provider', () => {
    const config = loadWorkerConfig({ E2B_API_KEY: 'e2b-key', E2B_TEMPLATE: 'e2b-template' });
    expect(config.sandboxProvider).toBe('e2b');
    expect(config.normalizationSandbox).toEqual({
      provider: 'e2b',
      apiKey: 'e2b-key',
      template: 'e2b-template',
      domain: 'e2b.dev',
    });
  });

  it('loads PPIO credentials and its default domain when selected', () => {
    const config = loadWorkerConfig({
      SANDBOX_PROVIDER: 'ppio',
      PPIO_API_KEY: 'ppio-key',
      PPIO_TEMPLATE: 'ppio-template',
      E2B_API_KEY: 'ignored-e2b-key',
    });
    expect(config.normalizationSandbox).toEqual({
      provider: 'ppio',
      apiKey: 'ppio-key',
      template: 'ppio-template',
      domain: 'sandbox.ppio.cn',
    });
  });

  it('does not configure PPIO from an E2B key', () => {
    const config = loadWorkerConfig({
      SANDBOX_PROVIDER: 'ppio',
      E2B_API_KEY: 'e2b-key',
    });
    expect(config.sandboxProvider).toBe('ppio');
    expect(config.normalizationSandbox).toBeUndefined();
  });

  it('rejects an unknown normalization sandbox provider', () => {
    expect(() => loadWorkerConfig({ SANDBOX_PROVIDER: 'local' })).toThrow(
      'Environment variable SANDBOX_PROVIDER must be one of: e2b, ppio',
    );
  });

  it('supports virtual-host style object storage endpoints', () => {
    expect(
      loadWorkerConfig({ OBJECT_STORAGE_FORCE_PATH_STYLE: 'false' }).objectStorageForcePathStyle,
    ).toBe(false);
  });
});
