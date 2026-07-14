import { describe, expect, it } from 'vitest';
import { estimateReadingSeconds, readingSecondsPerCharacter } from './estimate';

describe('reading estimates', () => {
  it('keeps the snapshot speed stable as the live remaining character count changes', () => {
    const secondsPerCharacter = readingSecondsPerCharacter(8_000, 80_000, 'zh');

    expect(estimateReadingSeconds(40_000, secondsPerCharacter)).toBe(4_000);
  });

  it('uses the language fallback when the stats snapshot is unavailable', () => {
    const secondsPerCharacter = readingSecondsPerCharacter(null, null, 'zh-CN');

    expect(estimateReadingSeconds(6_500, secondsPerCharacter)).toBe(1_000);
  });
});
