import { describe, expect, it } from 'vitest';
import { parsePartialJson } from './partial-json';

describe('parsePartialJson', () => {
  it('best-effort completes streamed Tool argument prefixes', () => {
    expect(parsePartialJson('{"brief":{"bookIdentity":"一本书"')).toEqual({
      brief: { bookIdentity: '一本书' },
    });
  });

  it('returns undefined for prefixes that cannot yet form a field', () => {
    expect(parsePartialJson('{"brief":')).toBeUndefined();
  });
});
