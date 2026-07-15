import { describe, expect, it } from 'vitest';
import type { QaSessionResponse } from './api';
import { proposalActionIdempotencyKey, turnsFromQaSession } from './AskAiPanel';

describe('proposalActionIdempotencyKey', () => {
  it('reuses a feedback key only for the same payload', () => {
    const cache = new Map<string, string>();
    let sequence = 0;
    const createKey = () => `key-${++sequence}`;

    const first = proposalActionIdempotencyKey(
      cache, createKey, 'feedback', 'proposal-1', 'revision-1', 'more examples',
    );
    const retry = proposalActionIdempotencyKey(
      cache, createKey, 'feedback', 'proposal-1', 'revision-1', 'more examples',
    );
    const changedFeedback = proposalActionIdempotencyKey(
      cache, createKey, 'feedback', 'proposal-1', 'revision-1', 'less detail',
    );

    expect(retry).toBe(first);
    expect(changedFeedback).not.toBe(first);
    expect(sequence).toBe(2);
  });

  it('separates otherwise identical feedback for different revisions', () => {
    const cache = new Map<string, string>();
    let sequence = 0;
    const createKey = () => `key-${++sequence}`;

    const firstRevision = proposalActionIdempotencyKey(
      cache, createKey, 'feedback', 'proposal-1', 'revision-1', 'keep this short',
    );
    const nextRevision = proposalActionIdempotencyKey(
      cache, createKey, 'feedback', 'proposal-1', 'revision-2', 'keep this short',
    );

    expect(nextRevision).not.toBe(firstRevision);
  });
});

describe('turnsFromQaSession', () => {
  it('keeps each proposal revision attached to its triggering answer', () => {
    const context = {
      anchor: 'screen' as const,
      precision: 'approximate' as const,
      nodeOrder: 1,
      sectionId: 'chapter-1',
      segment: 1,
      focus: { blockIndex: 1, offset: 0 },
      quoteSnapshot: 'context',
    };
    const revision = (id: string, messageId: string, number: number) => ({
      id,
      proposalId: 'proposal-1',
      revision: number,
      triggeringMessageId: messageId,
      strategyDraftVersionId: `draft-${number}`,
      publicSummary: `revision ${number}`,
      changedFields: ['annotations'],
      reason: 'reason',
      evidence: 'evidence',
      status: number === 2 ? ('pending' as const) : ('superseded' as const),
      createdAt: `2026-07-15T00:00:0${number}.000Z`,
    });
    const session: QaSessionResponse = {
      sessionId: 'session-1',
      status: 'active',
      conversationVersion: 4,
      questionContext: context,
      contextPrecision: 'approximate',
      messages: [
        { id: 'q1', sequence: 1, role: 'user', kind: 'question', content: 'first', createdAt: '2026-07-15T00:00:00.000Z', proposalRevision: null },
        { id: 'a1', sequence: 2, role: 'assistant', kind: 'answer', content: 'answer one', createdAt: '2026-07-15T00:00:01.000Z', proposalRevision: revision('r1', 'a1', 1) },
        { id: 'q2', sequence: 3, role: 'user', kind: 'question', content: 'feedback', createdAt: '2026-07-15T00:00:02.000Z', proposalRevision: null },
        { id: 'a2', sequence: 4, role: 'assistant', kind: 'answer', content: 'answer two', createdAt: '2026-07-15T00:00:03.000Z', proposalRevision: revision('r2', 'a2', 2) },
      ],
      proposal: {
        id: 'proposal-1',
        status: 'pending',
        publicSummary: 'revision 2',
        revision: 2,
        currentRevisionId: 'r2',
        currentStrategyDraftVersionId: 'draft-2',
        baseStrategyVersionId: 'strategy-1',
        resultingStrategyVersionId: null,
        createdAt: '2026-07-15T00:00:01.000Z',
      },
    };

    const turns = turnsFromQaSession(session);
    expect(turns.map((turn) => ({
      question: turn.question,
      answer: turn.answer,
      revision: turn.proposalRevision?.revision,
      status: turn.proposalRevision?.status,
    }))).toEqual([
      { question: 'first', answer: 'answer one', revision: 1, status: 'superseded' },
      { question: 'feedback', answer: 'answer two', revision: 2, status: 'pending' },
    ]);
  });
});
