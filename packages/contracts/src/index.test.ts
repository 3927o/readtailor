import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  BookNormalizationStatusSchema,
  HealthResponseSchema,
  ImportBookResponseSchema,
  SharedBookSchema,
  SystemJobPayloadSchema,
  SystemJobSchema,
} from './index';

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
