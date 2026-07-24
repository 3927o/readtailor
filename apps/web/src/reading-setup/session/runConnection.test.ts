/** Verifies that network connection projection remains separate from business workflow. */

import { describe, expect, it } from 'vitest';
import { reduceReadingSetupConnection } from './runConnection';

describe('reduceReadingSetupConnection', () => {
  it('distinguishes a reconnecting stream from a terminally closed connection', () => {
    expect(reduceReadingSetupConnection('connected', {
      type: 'interrupted',
      retrying: true,
    })).toBe('reconnecting');
    expect(reduceReadingSetupConnection('connected', {
      type: 'interrupted',
      retrying: false,
    })).toBe('disconnected');
  });
});
