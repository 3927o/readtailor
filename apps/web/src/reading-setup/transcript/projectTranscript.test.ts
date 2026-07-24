/** Verifies that transcript sources retain their user-visible ordering at the render boundary. */

import { describe, expect, it } from 'vitest';
import { projectReadingSetupTranscript } from './projectTranscript';

describe('projectReadingSetupTranscript', () => {
  it('places optimistic user input before the active run projection', () => {
    const entries = projectReadingSetupTranscript({
      persisted: [
        {
          id: 'assistant-1',
          kind: 'assistant',
          text: '先聊一个问题。',
          streaming: false,
        },
      ],
      optimistic: [
        {
          id: 'user-1',
          kind: 'user',
          text: '我更关心实际应用。',
          delivery: 'sending',
        },
      ],
      live: [
        {
          id: 'assistant-2',
          kind: 'assistant',
          text: '明白，我会按这个方向继续。',
          streaming: true,
        },
      ],
    });

    expect(entries.map((entry) => entry.id)).toEqual([
      'assistant-1',
      'user-1',
      'assistant-2',
    ]);
  });
});
