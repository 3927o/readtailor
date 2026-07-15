import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  AdoptTrialRequestSchema,
  ApproveStrategyRequestSchema,
  BookNormalizationStatusSchema,
  ContentGenerationJobPayloadSchema,
  CurrentReadingSetupOperationResponseSchema,
  GenerationResultSchema,
  HealthResponseSchema,
  ImportBookResponseSchema,
  InterviewQuestionSchema,
  InterviewStreamEventSchema,
  PasswordLoginRequestSchema,
  PasswordRegisterRequestSchema,
  ProvisionalTrialSampleSchema,
  ProposalDecisionRequestSchema,
  ProposalFeedbackRequestSchema,
  QaQuestionContextSchema,
  ReadingNodePreviewSchema,
  ReadingSetupOperationDetailParamsSchema,
  ReadingSetupOperationPayloadSchema,
  ReadingSetupOperationResponseSchema,
  SharedBookSchema,
  StrategyDraftSnapshotParamsSchema,
  StrategyRevisionStreamEventSchema,
  SubmitInterviewAnswerRequestSchema,
  SubmitStrategyFeedbackRequestSchema,
  SubmitTrialFeedbackRequestSchema,
  SystemJobPayloadSchema,
  SystemJobSchema,
  TrialRevisionSnapshotParamsSchema,
  TrialReviewResponseSchema,
  TrialSelectionStreamEventSchema,
  UserBookDetailResponseSchema,
} from './index';

describe('ask AI contracts', () => {
  const range = {
    start: { blockIndex: 1, offset: 0 },
    end: { blockIndex: 2, offset: 8 },
  };

  it('distinguishes exact highlights from approximate screen context', () => {
    expect(Value.Check(QaQuestionContextSchema, {
      anchor: 'highlight',
      precision: 'exact',
      nodeOrder: 3,
      sectionId: 'chapter-1',
      segment: 1,
      range,
      quoteSnapshot: 'selected text',
    })).toBe(true);
    expect(Value.Check(QaQuestionContextSchema, {
      anchor: 'screen',
      precision: 'approximate',
      nodeOrder: 3,
      sectionId: 'chapter-1',
      segment: 1,
      focus: { blockIndex: 1, offset: 4 },
      range,
      quoteSnapshot: 'visible text',
    })).toBe(true);
    expect(Value.Check(QaQuestionContextSchema, {
      anchor: 'highlight',
      precision: 'approximate',
      nodeOrder: 3,
      sectionId: 'chapter-1',
      segment: 1,
      range,
      quoteSnapshot: 'wrong precision',
    })).toBe(false);
  });

  it('requires revision and idempotency guards for proposal commands', () => {
    expect(Value.Check(ProposalFeedbackRequestSchema, {
      revisionId: 'revision-1',
      feedback: 'Please keep the annotations shorter.',
      idempotencyKey: 'feedback-1',
    })).toBe(true);
    expect(Value.Check(ProposalDecisionRequestSchema, {
      revisionId: 'revision-1',
      idempotencyKey: 'confirm-1',
    })).toBe(true);
  });
});

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

  it('binds trial segment results to their generation status', () => {
    const segment = {
      id: 'segment-1',
      ordinal: 1,
      sectionId: 'chapter-1',
      segment: 1,
      range: {
        start: { blockIndex: 1, offset: 0 },
        end: { blockIndex: 2, offset: 10 },
      },
      chapterPath: [],
      originalHtml: '<p>Original text.</p>',
      selectionReason: 'Represents the main conceptual threshold.',
      viewedAt: null,
    };

    expect(Value.Check(TrialReviewResponseSchema, {
      userBookId: 'user-book-id',
      workflowStatus: 'trial_generating',
      trialRevisionId: 'revision-id',
      revision: 1,
      status: 'generating',
      strategyDraftVersionId: 'draft-id',
      segments: [
        { ...segment, status: 'ready', result: generationResult },
        { ...segment, id: 'segment-2', ordinal: 2, status: 'generating', result: null },
        { ...segment, id: 'segment-3', ordinal: 3, status: 'failed', result: null },
      ],
      adjustmentCount: 0,
      adjustmentLimit: 5,
      canAdjust: true,
      canAdopt: false,
    })).toBe(true);
    expect(Value.Check(TrialReviewResponseSchema, {
      userBookId: 'user-book-id',
      workflowStatus: 'trial_generating',
      trialRevisionId: 'revision-id',
      revision: 1,
      status: 'generating',
      strategyDraftVersionId: 'draft-id',
      segments: [
        { ...segment, status: 'ready', result: null },
        { ...segment, id: 'segment-2', ordinal: 2, status: 'generating', result: generationResult },
        { ...segment, id: 'segment-3', ordinal: 3, status: 'failed', result: null },
      ],
      adjustmentCount: 0,
      adjustmentLimit: 5,
      canAdjust: true,
      canAdopt: false,
    })).toBe(false);
  });

  it('accepts the read-only user book detail response', () => {
    expect(
      Value.Check(UserBookDetailResponseSchema, {
        book: shelfBook,
        currentInterviewSessionId: 'interview-id',
        currentBookReaderProfileVersionId: 'book-reader-profile-id',
        currentStrategyDraftVersionId: 'strategy-draft-id',
        currentStrategyVersionId: null,
        currentTrialRevisionId: 'trial-id',
        adjustmentCount: 2,
        deletedAt: null,
        purgeAfter: null,
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-15T00:00:00.000Z',
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

describe('progressive reading setup contracts', () => {
  const ids = {
    userBook: '10000000-0000-0000-0000-000000000001',
    operation: '10000000-0000-0000-0000-000000000002',
    draft: '10000000-0000-0000-0000-000000000003',
    trial: '10000000-0000-0000-0000-000000000004',
    stream: '10000000-0000-0000-0000-000000000005',
  };

  const range = {
    start: { blockIndex: 1, offset: 0 },
    end: { blockIndex: 1, offset: 20 },
  };

  const previews = [
    {
      ordinal: 1,
      sectionId: 'chapter-1',
      segment: 1,
      chapterPath: ['Part I', 'Chapter 1'],
      reason: 'Entry threshold.',
    },
    {
      ordinal: 2,
      sectionId: 'chapter-2',
      segment: 1,
      chapterPath: ['Part I', 'Chapter 2'],
      reason: 'Typical argument.',
    },
    {
      ordinal: 3,
      sectionId: 'chapter-3',
      segment: 1,
      chapterPath: ['Part II', 'Chapter 3'],
      reason: 'Hardest concept.',
    },
  ];

  const strategy = {
    userBookId: ids.userBook,
    workflowStatus: 'strategy_review',
    draft: {
      id: ids.draft,
      version: 2,
      status: 'draft',
      readingBriefing: {
        bookIdentity: 'A book about systems.',
        arc: 'It moves from principles to practice.',
        assumedKnowledge: 'No specialist background required.',
        readingAdvice: 'Pause at the worked examples.',
      },
      userFacingSummary: 'Read for the core argument and its practical consequences.',
      strategy: {
        goals: ['Understand the central argument.'],
        expressionPrinciples: ['Prefer concise explanations.'],
        guide: { enabled: true, objectives: ['Orient each section.'] },
        annotations: { enabled: true, focuses: ['Key terms.'], exclusions: [] },
        afterReading: { enabled: false, objectives: [] },
        trialCandidates: previews.map(({ sectionId, segment, reason }) => ({
          sectionId,
          segment,
          reason,
        })),
      },
      createdAt: '2026-07-15T00:00:00.000Z',
      approvedForTrialAt: null,
    },
    trialCandidatePreviews: previews,
    adjustmentCount: 1,
    adjustmentLimit: 5,
    canAdjust: true,
  };

  const provisionalSample = {
    ordinal: 1,
    tag: 'threshold',
    sectionId: 'chapter-1',
    segment: 1,
    range,
    chapterPath: ['Part I', 'Chapter 1'],
    originalHtml: '<p>Original threshold text.</p>',
    selectionReason: 'Shows the entry threshold.',
  };

  const trial = {
    userBookId: ids.userBook,
    workflowStatus: 'trial_generating',
    trialRevisionId: ids.trial,
    revision: 1,
    status: 'generating',
    strategyDraftVersionId: ids.draft,
    segments: [1, 2, 3].map((ordinal) => ({
      id: `segment-${ordinal}`,
      ordinal,
      sectionId: `chapter-${ordinal}`,
      segment: 1,
      range,
      chapterPath: [`Chapter ${ordinal}`],
      originalHtml: `<p>Sample ${ordinal}</p>`,
      selectionReason: `Reason ${ordinal}`,
      status: 'generating',
      result: null,
      viewedAt: null,
    })),
    adjustmentCount: 1,
    adjustmentLimit: 5,
    canAdjust: true,
    canAdopt: false,
  };

  const envelope = {
    userBookId: ids.userBook,
    operationId: ids.operation,
    operationAttempt: 2,
    sequence: 1,
  };

  it('validates public node and provisional sample projections', () => {
    expect(Value.Check(ReadingNodePreviewSchema, previews[0])).toBe(true);
    expect(Value.Check(ProvisionalTrialSampleSchema, provisionalSample)).toBe(true);
    expect(
      Value.Check(ProvisionalTrialSampleSchema, {
        ...provisionalSample,
        ordinal: 2,
      }),
    ).toBe(false);
  });

  it('validates operation payloads, recovery responses, and UUID params', () => {
    expect(Value.Check(ReadingSetupOperationPayloadSchema, {
      source: 'strategy_feedback',
      strategyDraftVersionId: ids.draft,
      feedback: 'Use shorter annotations.',
    })).toBe(true);
    expect(Value.Check(ReadingSetupOperationPayloadSchema, {
      source: 'strategy_approve',
      strategyDraftVersionId: ids.draft,
    })).toBe(true);
    expect(Value.Check(ReadingSetupOperationPayloadSchema, {
      source: 'unknown',
    })).toBe(false);

    const operation = {
      operationId: ids.operation,
      operationAttempt: 2,
      kind: 'strategy_revision',
      source: 'trial_feedback',
      status: 'failed',
      baseDraftId: ids.draft,
      baseTrialRevisionId: ids.trial,
      resultDraftId: null,
      resultTrialRevisionId: null,
      canResume: true,
      errorSummary: 'The agent response was invalid.',
      recoverableInput: { feedback: 'Use shorter annotations.' },
    };
    expect(Value.Check(ReadingSetupOperationResponseSchema, operation)).toBe(true);
    expect(Value.Check(ReadingSetupOperationResponseSchema, {
      operationId: ids.operation,
      operationAttempt: 1,
      kind: 'trial_selection',
      source: 'strategy_approve',
      status: 'completed',
      baseDraftId: ids.draft,
      baseTrialRevisionId: null,
      resultDraftId: null,
      resultTrialRevisionId: ids.trial,
      canResume: false,
      errorSummary: null,
      recoverableInput: null,
    })).toBe(true);
    expect(Value.Check(CurrentReadingSetupOperationResponseSchema, null)).toBe(true);
    expect(Value.Check(ReadingSetupOperationResponseSchema, {
      ...operation,
      kind: 'trial_selection',
    })).toBe(false);
    expect(Value.Check(ReadingSetupOperationResponseSchema, {
      ...operation,
      operationId: 'not-a-uuid',
    })).toBe(false);
    expect(Value.Check(ReadingSetupOperationResponseSchema, {
      ...operation,
      errorSummary: null,
    })).toBe(false);

    expect(Value.Check(ReadingSetupOperationDetailParamsSchema, {
      id: ids.userBook,
      operationId: ids.operation,
    })).toBe(true);
    expect(Value.Check(StrategyDraftSnapshotParamsSchema, {
      id: ids.userBook,
      draftId: ids.draft,
    })).toBe(true);
    expect(Value.Check(TrialRevisionSnapshotParamsSchema, {
      id: ids.userBook,
      trialRevisionId: 'invalid',
    })).toBe(false);
  });

  it('requires stable idempotency keys on reading setup operation commands', () => {
    const commands = [
      [SubmitInterviewAnswerRequestSchema, {
        questionId: 'question-1',
        selectedOptionIds: ['overview'],
        freeText: null,
      }],
      [SubmitStrategyFeedbackRequestSchema, {
        strategyDraftVersionId: ids.draft,
        feedback: 'Make the guide more concise.',
      }],
      [ApproveStrategyRequestSchema, {
        strategyDraftVersionId: ids.draft,
      }],
      [SubmitTrialFeedbackRequestSchema, {
        trialRevisionId: ids.trial,
        feedback: 'Use a more representative sample.',
      }],
    ] as const;

    for (const [schema, command] of commands) {
      expect(Value.Check(schema, { ...command, idempotencyKey: 'command-1' })).toBe(true);
      expect(Value.Check(schema, command)).toBe(false);
      expect(Value.Check(schema, { ...command, idempotencyKey: '' })).toBe(false);
      expect(Value.Check(schema, { ...command, idempotencyKey: '   ' })).toBe(false);
    }
    expect(Value.Check(SubmitStrategyFeedbackRequestSchema, {
      strategyDraftVersionId: ids.draft,
      feedback: '   ',
      idempotencyKey: 'command-1',
    })).toBe(false);
    expect(Value.Check(SubmitTrialFeedbackRequestSchema, {
      trialRevisionId: 'not-a-uuid',
      feedback: 'Use a more representative sample.',
      idempotencyKey: 'command-1',
    })).toBe(false);
  });

  it('validates interview question and progressive draft stream events', () => {
    const interviewEnvelope = {
      userBookId: ids.userBook,
      streamId: ids.stream,
      sequence: 1,
    };
    const events = [
      { ...interviewEnvelope, type: 'speculative_reset', speculativeEpoch: 1, phase: 'interviewing' },
      { ...interviewEnvelope, type: 'draft_started', speculativeEpoch: 1, conversationVersion: 6 },
      { ...interviewEnvelope, type: 'briefing_delta', speculativeEpoch: 1, field: 'book_identity', chars: 'A systems book.' },
      { ...interviewEnvelope, type: 'strategy_delta', speculativeEpoch: 1, chars: 'Read for the argument.' },
      { ...interviewEnvelope, type: 'reading_node_added', speculativeEpoch: 1, node: previews[0] },
      { ...interviewEnvelope, type: 'draft_final', strategy },
      { ...interviewEnvelope, type: 'done', workflowStatus: 'strategy_review' },
      { ...interviewEnvelope, type: 'error', code: 'lease_lost', message: 'Lease lost.' },
    ];
    for (const event of events) expect(Value.Check(InterviewStreamEventSchema, event)).toBe(true);
    expect(Value.Check(InterviewStreamEventSchema, {
      ...events[2],
      field: 'unknown',
    })).toBe(false);
    expect(Value.Check(InterviewStreamEventSchema, {
      ...events[3],
      sequence: 0,
    })).toBe(false);
    expect(Value.Check(InterviewStreamEventSchema, {
      ...events[4],
      speculativeEpoch: 0,
    })).toBe(false);
  });

  it('validates every strategy revision stream discriminator and envelope', () => {
    const events = [
      {
        ...envelope,
        type: 'speculative_reset',
        speculativeEpoch: 2,
        phase: 'strategy_review',
      },
      {
        ...envelope,
        type: 'revision_started',
        speculativeEpoch: 2,
        source: 'strategy_feedback',
        baseDraftId: ids.draft,
        baseTrialRevisionId: null,
      },
      {
        ...envelope,
        type: 'strategy_delta',
        speculativeEpoch: 2,
        chars: 'Read for the argument.',
      },
      {
        ...envelope,
        type: 'reading_node_added',
        speculativeEpoch: 2,
        node: previews[0],
      },
      {
        ...envelope,
        type: 'revision_final',
        strategy,
      },
      {
        ...envelope,
        type: 'error',
        code: 'validation_failed',
        message: 'The revised strategy was invalid.',
      },
    ];

    for (const event of events) {
      expect(Value.Check(StrategyRevisionStreamEventSchema, event)).toBe(true);
    }
    expect(Value.Check(StrategyRevisionStreamEventSchema, {
      ...events[2],
      operationAttempt: 0,
    })).toBe(false);
    expect(Value.Check(StrategyRevisionStreamEventSchema, {
      ...events[1],
      source: 'trial_feedback',
      baseTrialRevisionId: null,
    })).toBe(false);
  });

  it('validates every trial selection stream discriminator and fixed slots', () => {
    const events = [
      {
        ...envelope,
        type: 'speculative_reset',
        speculativeEpoch: 1,
        phase: 'select_trial',
      },
      {
        ...envelope,
        type: 'selection_started',
        speculativeEpoch: 1,
        draftId: ids.draft,
        slots: [
          { ordinal: 1, tag: 'threshold' },
          { ordinal: 2, tag: 'typical' },
          { ordinal: 3, tag: 'hardest' },
        ],
      },
      {
        ...envelope,
        type: 'fragment_selected',
        speculativeEpoch: 1,
        draftId: ids.draft,
        sample: provisionalSample,
      },
      {
        ...envelope,
        type: 'trial_created',
        draftId: ids.draft,
        trial,
      },
      {
        ...envelope,
        type: 'error',
        code: 'lease_lost',
        message: 'The operation lease was lost.',
      },
    ];

    for (const event of events) {
      expect(Value.Check(TrialSelectionStreamEventSchema, event)).toBe(true);
    }
    expect(Value.Check(TrialSelectionStreamEventSchema, {
      ...events[1],
      slots: [
        { ordinal: 1, tag: 'threshold' },
        { ordinal: 3, tag: 'hardest' },
        { ordinal: 2, tag: 'typical' },
      ],
    })).toBe(false);
    expect(Value.Check(TrialSelectionStreamEventSchema, {
      ...events[2],
      speculativeEpoch: 0,
    })).toBe(false);
  });
});
