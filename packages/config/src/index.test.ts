import { describe, expect, it } from 'vitest';
import { readInteger, readModelEndpoint, requireCompleteModelEndpoint } from './index';

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

describe('readModelEndpoint', () => {
  const global = {
    MODEL_API_BASE_URL: 'https://global.example.com',
    MODEL_API_KEY: 'global-key',
    MODEL_NAME: 'global-model',
  };

  it('falls back to the global MODEL_* vars when no prefix is set', () => {
    expect(readModelEndpoint(global, 'SYSTEM_CHAT')).toEqual({
      baseUrl: 'https://global.example.com',
      apiKey: 'global-key',
      modelName: 'global-model',
    });
  });

  it('overrides individual fields per feature and inherits the rest', () => {
    expect(
      readModelEndpoint({ ...global, SYSTEM_CHAT_MODEL_NAME: 'chat-model' }, 'SYSTEM_CHAT'),
    ).toEqual({
      baseUrl: 'https://global.example.com',
      apiKey: 'global-key',
      modelName: 'chat-model',
    });
  });

  it('routes a feature to an entirely different provider', () => {
    expect(
      readModelEndpoint(
        {
          ...global,
          SYSTEM_CHAT_MODEL_API_BASE_URL: 'https://other.example.com',
          SYSTEM_CHAT_MODEL_API_KEY: 'other-key',
          SYSTEM_CHAT_MODEL_NAME: 'other-model',
        },
        'SYSTEM_CHAT',
      ),
    ).toEqual({
      baseUrl: 'https://other.example.com',
      apiKey: 'other-key',
      modelName: 'other-model',
    });
  });

  it('resolves prefixes in order before the global fallback', () => {
    // book-analysis inherits normalization's config before the global default.
    expect(
      readModelEndpoint(
        { ...global, NORMALIZATION_MODEL_NAME: 'norm-model' },
        'BOOK_ANALYSIS',
        'NORMALIZATION',
      ),
    ).toEqual({
      baseUrl: 'https://global.example.com',
      apiKey: 'global-key',
      modelName: 'norm-model',
    });
    // An explicit book-analysis override wins over the inherited normalization one.
    expect(
      readModelEndpoint(
        { ...global, NORMALIZATION_MODEL_NAME: 'norm-model', BOOK_ANALYSIS_MODEL_NAME: 'analysis-model' },
        'BOOK_ANALYSIS',
        'NORMALIZATION',
      ).modelName,
    ).toBe('analysis-model');
  });
});

describe('requireCompleteModelEndpoint', () => {
  it('returns the resolved endpoint when fully configured', () => {
    expect(
      requireCompleteModelEndpoint(
        { baseUrl: 'https://x', apiKey: 'k', modelName: 'm' },
        'system-chat',
      ),
    ).toEqual({ baseUrl: 'https://x', apiKey: 'k', modelName: 'm' });
  });

  it('returns undefined when nothing is configured', () => {
    expect(
      requireCompleteModelEndpoint(
        { baseUrl: undefined, apiKey: undefined, modelName: undefined },
        'system-chat',
      ),
    ).toBeUndefined();
  });

  it('throws on a partial configuration', () => {
    expect(() =>
      requireCompleteModelEndpoint(
        { baseUrl: 'https://x', apiKey: undefined, modelName: 'm' },
        'system-chat',
      ),
    ).toThrow('partial model configuration for system-chat');
  });
});
