import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { HealthResponseSchema, SystemJobPayloadSchema, SystemJobSchema } from './index';

describe('HealthResponseSchema', () => {
  it('accepts the service health contract', () => {
    expect(
      Value.Check(HealthResponseSchema, {
        service: 'api',
        status: 'ok',
        version: '0.0.0',
        timestamp: '2026-07-13T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('accepts optional dependency statuses and rejects unknown values', () => {
    const base = {
      service: 'api',
      status: 'degraded',
      version: '0.0.0',
      timestamp: '2026-07-13T00:00:00.000Z',
    };
    expect(
      Value.Check(HealthResponseSchema, {
        ...base,
        dependencies: { database: 'ok', redis: 'error' },
      }),
    ).toBe(true);
    expect(
      Value.Check(HealthResponseSchema, {
        ...base,
        dependencies: { database: 'down' },
      }),
    ).toBe(false);
  });
});

describe('SystemJobPayloadSchema', () => {
  it('requires the database row id', () => {
    expect(
      Value.Check(SystemJobPayloadSchema, {
        jobId: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
        kind: 'system.ping',
        requestedAt: '2026-07-13T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemJobPayloadSchema, {
        kind: 'system.ping',
        requestedAt: '2026-07-13T00:00:00.000Z',
      }),
    ).toBe(false);
  });
});

describe('SystemJobSchema', () => {
  it('accepts a queued job with a null completion time', () => {
    expect(
      Value.Check(SystemJobSchema, {
        id: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
        kind: 'system.ping',
        status: 'queued',
        result: null,
        createdAt: '2026-07-13T00:00:00.000Z',
        completedAt: null,
      }),
    ).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(
      Value.Check(SystemJobSchema, {
        id: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
        kind: 'system.ping',
        status: 'unknown',
        result: null,
        createdAt: '2026-07-13T00:00:00.000Z',
        completedAt: null,
      }),
    ).toBe(false);
  });
});
