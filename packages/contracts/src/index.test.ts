import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  AdoptTrialRequestSchema,
  BookNormalizationStatusSchema,
  ContentGenerationJobPayloadSchema,
  GenerationResultSchema,
  HealthResponseSchema,
  ImportBookResponseSchema,
  InterviewQuestionSchema,
  PasswordLoginRequestSchema,
  PasswordRegisterRequestSchema,
  SharedBookSchema,
  SystemJobPayloadSchema,
  SystemJobSchema,
  TrialReviewResponseSchema,
  UserBookWorkflowResponseSchema,
} from './index';

describe('password authentication contracts', () => {
  it('accepts valid registration and login payloads', () => {
    expect(Value.Check(PasswordRegisterRequestSchema, {
      displayName: 'Reader',
      email: 'reader@example.com',
      password: 'correct horse battery staple',
    })).toBe(true);
    expect(Value.Check(PasswordLoginRequestSchema, {
      email: 'reader@example.com',
      password: 'password',
    })).toBe(true);
  });

  it('rejects short registration passwords and oversized fields', () => {
    expect(Value.Check(PasswordRegisterRequestSchema, {
      displayName: 'Reader',
      email: 'reader@example.com',
      password: 'short',
    })).toBe(false);
    expect(Value.Check(PasswordRegisterRequestSchema, {
      displayName: 'R'.repeat(101),
      email: 'reader@example.com',
      password: 'correct horse battery staple',
    })).toBe(false);
  });
});

describe('HealthResponseSchema', () => {
  it('accepts the service health contract', () => {
    expect(
      Value.Check(HealthResponseSchema, {
        service: 'api',
        status: 'ok',
        version: '0.0.0',
        timestamp: '2026-07-13T00:00:00.000Z',
      }),
    ).toBe(true);
  });

  it('accepts optional dependency statuses and rejects unknown values', () => {
    const base = {
      service: 'api',
      status: 'degraded',
      version: '0.0.0',
      timestamp: '2026-07-13T00:00:00.000Z',
    };
    expect(
      Value.Check(HealthResponseSchema, {
        ...base,
        dependencies: { database: 'ok', redis: 'error' },
      }),
    ).toBe(true);
    expect(
      Value.Check(HealthResponseSchema, {
        ...base,
        dependencies: { database: 'down' },
      }),
    ).toBe(false);
  });
});

describe('SystemJobPayloadSchema', () => {
  it('requires the database row id', () => {
    expect(
      Value.Check(SystemJobPayloadSchema, {
        jobId: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
        kind: 'system.ping',
        requestedAt: '2026-07-13T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      Value.Check(SystemJobPayloadSchema, {
        kind: 'system.ping',
        requestedAt: '2026-07-13T00:00:00.000Z',
      }),
    ).toBe(false);
  });
});

describe('SystemJobSchema', () => {
  it('accepts a queued job with a null completion time', () => {
    expect(
      Value.Check(SystemJobSchema, {
        id: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
        kind: 'system.ping',
        status: 'queued',
        result: null,
        createdAt: '2026-07-13T00:00:00.000Z',
        completedAt: null,
      }),
    ).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(
      Value.Check(SystemJobSchema, {
        id: 'a3bb189e-8bf9-3888-9912-ace4e6543002',
        kind: 'system.ping',
        status: 'unknown',
        result: null,
        createdAt: '2026-07-13T00:00:00.000Z',
        completedAt: null,
      }),
    ).toBe(false);
  });
});

describe('SharedBookSchema', () => {
  it('accepts a ready book with an immutable package', () => {
    expect(
      Value.Check(SharedBookSchema, {
        id: 'book-id',
        epubSha256: 'a'.repeat(64),
        status: 'ready',
        title: 'Book',
        authors: ['Author'],
        language: 'zh',
        coverPath: 'assets/cover.jpg',
        identifiers: { isbn: '123' },
        publisher: null,
        publishedDate: null,
        sourceFilename: 'book.epub',
        package: {
          id: 'package-id',
          version: 'v1',
          contractVersion: 'nb-1.0',
          manifestVersion: 'reading-nodes-1.0',
          createdAt: '2026-07-13T00:00:00.000Z',
        },
      }),
    ).toBe(true);
  });
});

describe('book normalization contracts', () => {
  const book = {
    id: 'book-id',
    epubSha256: 'a'.repeat(64),
    status: 'normalizing',
    title: 'Book',
    authors: [],
    coverPath: null,
    sourceFilename: 'book.epub',
    errorSummary: null,
    failureType: null,
    createdAt: '2026-07-13T00:00:00.000Z',
    updatedAt: '2026-07-13T00:00:01.000Z',
  };

  it('accepts import responses and live attempt diagnostics', () => {
    expect(Value.Check(ImportBookResponseSchema, {
      bookId: 'book-id',
      runId: 'run-id',
      reused: false,
      status: 'queued',
    })).toBe(true);
    expect(Value.Check(BookNormalizationStatusSchema, {
      book,
      run: {
        id: 'run-id',
        status: 'running',
        step: 'normalizing',
        attempt: 1,
        errorSummary: null,
        startedAt: '2026-07-13T00:00:01.000Z',
        completedAt: null,
        latestAttempt: {
          attemptNo: 1,
          status: 'running',
          turnCount: 8,
          toolCallCount: 12,
          blockingErrorCount: 0,
          warningCount: 3,
          errorSummary: null,
          startedAt: '2026-07-13T00:00:02.000Z',
          completedAt: null,
        },
      },
    })).toBe(true);
  });
});

describe('phase three workflow contracts', () => {
  const shelfBook = {
    id: 'user-book-id',
    sharedBookId: 'shared-book-id',
    sharedBookStatus: 'ready',
    workflowStatus: 'trial_review',
    title: 'Book',
    authors: ['Author'],
    coverPath: null,
    errorSummary: null,
    failureType: null,
    progress: null,
    lastActivityAt: '2026-07-14T00:00:00.000Z',
  };

  const generationResult = {
    guide: 'Read this first.',
    annotations: [
      {
        id: 'annotation-1',
        range: {
          start: { blockIndex: 2, offset: 4 },
          end: { blockIndex: 2, offset: 8 },
        },
        content: 'A precise annotation.',
      },
    ],
    afterReading: null,
  };

  it('limits interview questions to two through five options', () => {
    const question = {
      id: 'question-1',
      acknowledgment: '',
      prompt: 'What do you want from this book?',
      allowFreeText: true,
      profileDimension: 'purpose',
      sufficiency: 40,
    };

    expect(
      Value.Check(InterviewQuestionSchema, {
        ...question,
        options: [
          { id: 'a', label: 'Overview' },
          { id: 'b', label: 'Deep study' },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(InterviewQuestionSchema, {
        ...question,
        options: [{ id: 'a', label: 'Only choice' }],
      }),
    ).toBe(false);
  });

  it('accepts UTF-16 block ranges and rejects invalid block indexes', () => {
    expect(Value.Check(GenerationResultSchema, generationResult)).toBe(true);
    expect(
      Value.Check(GenerationResultSchema, {
        ...generationResult,
        annotations: [
          {
            id: 'annotation-invalid',
            range: {
              start: { blockIndex: 0, offset: 0 },
              end: { blockIndex: 1, offset: 1 },
            },
            content: 'Invalid range.',
          },
        ],
      }),
    ).toBe(false);
  });

  it('requires exactly three segments for a trial review', () => {
    const segment = {
      id: 'segment-1',
      ordinal: 1,
      sectionId: 'chapter-1',
      segment: 1,
      range: {
        start: { blockIndex: 1, offset: 0 },
        end: { blockIndex: 2, offset: 10 },
      },
      chapterPath: ['Part I', 'Chapter 1'],
      originalHtml: '<p>Original text.</p>',
      selectionReason: 'Represents the main conceptual threshold.',
      status: 'ready',
      result: generationResult,
      viewedAt: '2026-07-14T00:00:00.000Z',
    };
    const review = {
      userBookId: 'user-book-id',
      workflowStatus: 'trial_review',
      trialRevisionId: 'revision-id',
      revision: 1,
      status: 'published',
      strategyDraftVersionId: 'draft-id',
      adjustmentCount: 0,
      adjustmentLimit: 5,
      canAdjust: true,
      canAdopt: true,
    };

    expect(
      Value.Check(TrialReviewResponseSchema, {
        ...review,
        segments: [
          segment,
          { ...segment, id: 'segment-2', ordinal: 2 },
          { ...segment, id: 'segment-3', ordinal: 3 },
        ],
      }),
    ).toBe(true);
    expect(Value.Check(TrialReviewResponseSchema, { ...review, segments: [segment] })).toBe(
      false,
    );
  });

  it('accepts the resumable aggregate workflow response', () => {
    expect(
      Value.Check(UserBookWorkflowResponseSchema, {
        workflowStatus: 'trial_review',
        book: shelfBook,
        interview: null,
        strategy: null,
        trial: null,
      }),
    ).toBe(true);
  });

  it('binds generation and adoption requests to direct business ids', () => {
    expect(
      Value.Check(ContentGenerationJobPayloadSchema, {
        kind: 'content.generate',
        generationId: 'generation-id',
        userBookId: 'user-book-id',
        scope: 'trial',
        requestedAt: '2026-07-14T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(
      Value.Check(AdoptTrialRequestSchema, {
        trialRevisionId: 'revision-id',
        strategyDraftVersionId: 'draft-id',
        idempotencyKey: 'adopt-1',
      }),
    ).toBe(true);
  });
});
