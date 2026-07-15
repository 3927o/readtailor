import { describe, expect, it } from 'vitest';
import {
  applyReaderProfilePatch,
  decodeQaSessionCursor,
  encodeQaSessionCursor,
  proposalActionPayloadMatches,
  UserBookError,
} from './user-books';

describe('QA session pagination cursor', () => {
  it('round-trips the timestamp and stable session-id tie breaker', () => {
    const cursor = {
      updatedAt: '2026-07-15T00:00:01.123Z',
      sessionId: '11111111-1111-4111-8111-111111111111',
    };
    expect(decodeQaSessionCursor(encodeQaSessionCursor(cursor))).toEqual(cursor);
  });

  it('rejects malformed or non-UUID cursor payloads as a user error', () => {
    const malformed = Buffer.from(JSON.stringify({
      updatedAt: '2026-07-15T00:00:01.123Z',
      sessionId: 'not-a-session-id',
    })).toString('base64url');

    for (const cursor of ['not-json', malformed]) {
      try {
        decodeQaSessionCursor(cursor);
        throw new Error('expected cursor decoding to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(UserBookError);
        expect((error as UserBookError).statusCode).toBe(400);
      }
    }
  });
});

describe('proposal action payload equality', () => {
  it('ignores JSON object key insertion order during idempotent replay', () => {
    expect(proposalActionPayloadMatches(
      { feedback: '更精简', revisionId: 'revision-1' },
      { revisionId: 'revision-1', feedback: '更精简' },
    )).toBe(true);
  });

  it('still rejects a reused key with a different payload', () => {
    expect(proposalActionPayloadMatches(
      { feedback: '更精简', revisionId: 'revision-1' },
      { revisionId: 'revision-1', feedback: '更详细' },
    )).toBe(false);
  });
});

describe('applyReaderProfilePatch', () => {
  it('removes inaccurate long-term profile items before adding replacements', () => {
    const next = applyReaderProfilePatch(
      {
        summary: 'reader',
        knowledge: ['文学与艺术', '计算机与互联网'],
        explanationPreferences: ['先讲叙事', '多补互联网背景'],
      },
      {
        knowledge: ['哲学社科'],
        remove_knowledge: ['计算机与互联网'],
        explanation_preferences: ['按文本推进'],
        remove_explanation_preferences: ['多补互联网背景'],
      },
    );

    expect(next).toEqual({
      summary: 'reader',
      knowledge: ['文学与艺术', '哲学社科'],
      explanationPreferences: ['先讲叙事', '按文本推进'],
    });
  });

  it('keeps an item when the same patch removes and re-adds it as a replacement', () => {
    const next = applyReaderProfilePatch(
      {
        summary: 'reader',
        knowledge: ['计算机与互联网'],
        explanationPreferences: [],
      },
      {
        knowledge: ['计算机与互联网'],
        remove_knowledge: ['计算机与互联网'],
      },
    );

    expect(next.knowledge).toEqual(['计算机与互联网']);
  });
});
