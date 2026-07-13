import { describe, expect, it } from 'vitest';
import { loadApiConfig } from './config';

describe('loadApiConfig', () => {
  it('rejects an invalid API port', () => {
    expect(() => loadApiConfig({ API_PORT: '1.5' })).toThrow(
      'Environment variable API_PORT must be an integer',
    );
  });
});
