import { describe, expect, it } from 'vitest';
import { loadApiConfig } from './config';

describe('loadApiConfig', () => {
  it('trusts the fallback Vite dev port when 5173 is occupied', () => {
    expect(loadApiConfig({}).webOrigins).toEqual(expect.arrayContaining([
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
    ]));
  });

  it('rejects an invalid API port', () => {
    expect(() => loadApiConfig({ API_PORT: '1.5' })).toThrow(
      'Environment variable API_PORT must be an integer',
    );
  });
});
