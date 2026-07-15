import { afterEach, describe, expect, it, vi } from 'vitest';
import { resumeInterview, startInterview } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
});

function interviewResponse(turnInProgress: boolean): Response {
  return Response.json({
    sessionId: 'session-1',
    status: 'active',
    turnInProgress,
    questionCount: 1,
    maxQuestions: 7,
    currentQuestion: null,
    sufficiency: null,
    answers: [],
  });
}

describe('interview lifecycle commands', () => {
  it.each([
    ['start', startInterview],
    ['resume', resumeInterview],
  ] as const)('posts the explicit %s command without an idempotency payload', async (command, request) => {
    const fetchMock = vi.fn().mockResolvedValue(interviewResponse(true));
    vi.stubGlobal('fetch', fetchMock);

    await expect(request('book/1')).resolves.toMatchObject({
      status: 'generating',
      turnInProgress: true,
      canResume: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`/v1/user-books/book%2F1/interview/${command}$`)),
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: '{}',
      }),
    );
  });

  it('marks an unleased pending turn as resumable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(interviewResponse(false)));

    await expect(resumeInterview('book-1')).resolves.toMatchObject({
      status: 'generating',
      turnInProgress: false,
      canResume: true,
    });
  });
});
