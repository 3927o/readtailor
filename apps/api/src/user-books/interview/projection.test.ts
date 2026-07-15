import { describe, expect, it } from 'vitest';
import {
  interviewAnswers,
  interviewMessages,
  interviewSessions,
} from '@readtailor/database';
import {
  mapInterviewBookReaderProfile,
  mapInterviewBriefing,
  mapInterviewQuestion,
  projectInterviewState,
} from './projection';

type SessionRow = typeof interviewSessions.$inferSelect;
type MessageRow = typeof interviewMessages.$inferSelect;
type AnswerRow = typeof interviewAnswers.$inferSelect;

const question = mapInterviewQuestion({
  id: 'purpose',
  acknowledgment: '明白了',
  prompt: '你希望获得什么？',
  options: [{ id: 'overview', label: '了解全貌' }],
  allow_text: true,
  profile_dimension: 'purpose',
  sufficiency: 40,
});

describe('interview projections', () => {
  it('maps agent output to persisted contract shapes', () => {
    expect(question).toMatchObject({
      allowFreeText: true,
      profileDimension: 'purpose',
    });
    expect(mapInterviewBookReaderProfile({
      summary: 'summary',
      motivations: ['完成阅读'],
      prior_knowledge: ['基础知识'],
      reading_goals: ['理解主线'],
      likely_barriers: ['术语较多'],
    })).toMatchObject({
      purpose: '完成阅读',
      desiredDepthOrOutcome: '理解主线',
      otherConclusions: ['summary'],
    });
    expect(mapInterviewBriefing({
      book_identity: 'identity',
      arc: 'arc',
      assumed_knowledge: 'knowledge',
      reading_advice: 'advice',
    })).toEqual({
      bookIdentity: 'identity',
      arc: 'arc',
      assumedKnowledge: 'knowledge',
      readingAdvice: 'advice',
    });
  });

  it('projects the current question, readable answer history and active lease', () => {
    const firstQuestion = {
      id: 'question-1',
      sequence: 1,
      role: 'assistant',
      kind: 'question',
      content: question.prompt,
      payload: question,
      interviewSessionId: 'session-1',
      idempotencyKey: null,
      createdAt: new Date('2026-07-16T00:00:00.000Z'),
    } as MessageRow;
    const secondQuestion = {
      ...firstQuestion,
      id: 'question-2',
      sequence: 3,
      payload: { ...question, id: 'depth', prompt: '你希望读多深？', sufficiency: 70 },
    } as MessageRow;
    const answer = {
      id: 'answer-1',
      interviewSessionId: 'session-1',
      questionMessageId: firstQuestion.id,
      selectedOptionIds: ['overview'],
      freeText: '并形成笔记',
      idempotencyKey: 'answer-key',
      createdAt: new Date('2026-07-16T00:01:00.000Z'),
    } as AnswerRow;
    const session = {
      id: 'session-1',
      status: 'active',
      questionCount: 2,
      conversationVersion: 3,
      turnLeaseId: 'lease-1',
      turnLeaseVersion: 3,
      turnLeaseClaimedAt: new Date('2026-07-16T00:02:00.000Z'),
      turnLeaseExpiresAt: new Date('2026-07-16T00:08:00.000Z'),
      completedAt: null,
      createdAt: new Date('2026-07-16T00:00:00.000Z'),
      updatedAt: new Date('2026-07-16T00:02:00.000Z'),
      userBookId: 'book-1',
    } as SessionRow;

    expect(projectInterviewState({
      session,
      messages: [firstQuestion, secondQuestion],
      answers: [{ answer, question: firstQuestion }],
      now: new Date('2026-07-16T00:03:00.000Z'),
    })).toMatchObject({
      turnInProgress: true,
      completionStarted: false,
      currentQuestion: { id: 'depth', prompt: '你希望读多深？' },
      sufficiency: 70,
      answers: [{
        questionId: 'purpose',
        question: '你希望获得什么？',
        answerText: '了解全貌；并形成笔记',
      }],
    });
  });

  it('projects durable interview completion state from summary checkpoints', () => {
    const session = {
      id: 'session-1',
      status: 'active',
      questionCount: 2,
      conversationVersion: 3,
      turnLeaseId: null,
      turnLeaseVersion: 3,
      turnLeaseClaimedAt: null,
      turnLeaseExpiresAt: null,
      completedAt: null,
      createdAt: new Date('2026-07-16T00:00:00.000Z'),
      updatedAt: new Date('2026-07-16T00:02:00.000Z'),
      userBookId: 'book-1',
    } as SessionRow;
    const completionStarted = {
      id: 'checkpoint-1',
      sequence: 4,
      role: 'assistant',
      kind: 'summary',
      content: '',
      payload: {
        type: 'completion_started',
        completionId: 'completion-1',
        baseConversationVersion: 3,
      },
      interviewSessionId: 'session-1',
      idempotencyKey: null,
      createdAt: new Date('2026-07-16T00:03:00.000Z'),
    } as MessageRow;

    expect(projectInterviewState({
      session,
      messages: [completionStarted],
      answers: [],
    })).toMatchObject({
      completionStarted: true,
      currentQuestion: null,
    });
  });
});
