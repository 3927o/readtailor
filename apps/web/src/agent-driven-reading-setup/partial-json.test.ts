import { describe, expect, it } from 'vitest';
import { parsePartialJson } from './partial-json';

describe('parsePartialJson', () => {
  it('best-effort completes streamed Tool argument prefixes', () => {
    expect(parsePartialJson('{"brief":{"bookIdentity":"一本书"')).toEqual({
      brief: { bookIdentity: '一本书' },
    });
  });

  it('preserves the containing object before its first field value arrives', () => {
    expect(parsePartialJson('{"brief":')).toEqual({});
  });

  it('keeps completed fields while the next object key is still streaming', () => {
    const prompt = '你希望怎么读？';
    const prefixes = [
      `{"prompt":"${prompt}"`,
      `{"prompt":"${prompt}",`,
      `{"prompt":"${prompt}","`,
      `{"prompt":"${prompt}","opt`,
      `{"prompt":"${prompt}","options"`,
      `{"prompt":"${prompt}","options":`,
      `{"prompt":"${prompt}","options":[`,
    ];

    expect(prefixes.map((source) => parsePartialJson(source))).toEqual([
      { prompt },
      { prompt },
      { prompt },
      { prompt },
      { prompt },
      { prompt },
      { prompt, options: [] },
    ]);
  });
});
