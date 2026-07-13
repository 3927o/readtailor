import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from './index';

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
});
