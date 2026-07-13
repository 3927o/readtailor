import { describe, expect, it } from 'vitest';
import { readInteger } from './index';

describe('readInteger', () => {
  it('reads an integer within the configured range', () => {
    expect(readInteger({ PORT: '3001' }, 'PORT', 80, { min: 1, max: 65_535 })).toBe(3001);
  });

  it.each(['1.5', '0', '65536'])("rejects an invalid port value '%s'", (value) => {
    expect(() => readInteger({ PORT: value }, 'PORT', 80, { min: 1, max: 65_535 })).toThrow(
      'Environment variable PORT',
    );
  });
});
